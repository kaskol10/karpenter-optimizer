package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/karpenter-optimizer/internal/alerts"
)

// maskedSentinel is appended to a channel URL when it is masked for display.
// The PUT handler recognizes this sentinel to preserve the real URL for a
// channel the client did not actually change.
const maskedSentinel = "/*"

func maskedURL(u string) bool { return strings.HasSuffix(u, maskedSentinel) }

// getAlertsConfig returns the alerting config. Channel URLs are masked (host
// kept, path redacted) — they are credentials, not display data. The rest of
// the config (conditions, reminders, enabled) round-trips normally, so a client
// can PUT it back and the real URLs are preserved.
//
// @Summary      Alerting configuration
// @Description  Returns the alerting config with channel URLs masked.
// @Tags         alerts
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Alerting config"
// @Router       /alerts/config [get]
func (s *Server) getAlertsConfig(c *gin.Context) {
	if s.alertsManager == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "alerts not configured"})
		return
	}
	cfg := s.alertsManager.Config()
	// Mask the channel URLs in the returned config (and expose a masked list).
	masked := make([]alerts.ChannelConfig, len(cfg.Channels))
	for i, ch := range cfg.Channels {
		masked[i] = ch
		masked[i].URL = maskChannelURL(ch.URL)
	}
	out := cfg
	out.Channels = masked
	c.JSON(http.StatusOK, gin.H{"config": out})
}

// getAlertsStatus godoc
// @Summary      Firing alerts
// @Description  Whether alerting is on and which conditions are firing now, for the header status strip. Always 200; `enabled` is false when alerting is off or has no channel.
// @Tags         alerts
// @Produce      json
// @Success      200  {object}  map[string]interface{}
// @Router       /alerts/status [get]
func (s *Server) getAlertsStatus(c *gin.Context) {
	if s.alertsManager == nil {
		c.JSON(http.StatusOK, gin.H{"enabled": false, "firing": []alerts.FiringAlert{}})
		return
	}
	enabled, firing := s.alertsManager.Status()
	c.JSON(http.StatusOK, gin.H{"enabled": enabled, "firing": firing})
}

func maskChannelURL(u string) string {
	return alerts.MaskURL(u)
}

// putAlertsConfig replaces the alerting configuration and persists it. For any
// channel whose URL still carries the masked sentinel, the server restores the
// previously-stored URL (by index) so toggling a condition or the enabled flag
// never wipes real channel secrets.
//
// @Summary      Update alerting configuration
// @Description  Replaces the alerting config (conditions, reminders, channels).
// @Tags         alerts
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Updated config"
// @Failure      400  {object}  map[string]interface{}  "Bad request"
// @Router       /alerts/config [put]
func (s *Server) putAlertsConfig(c *gin.Context) {
	if s.alertsManager == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "alerts not configured"})
		return
	}
	var incoming alerts.Config
	if err := c.ShouldBindJSON(&incoming); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid alert config: " + err.Error()})
		return
	}
	existing := s.alertsManager.Config()
	channels := make([]alerts.ChannelConfig, 0, len(incoming.Channels))
	for i, ch := range incoming.Channels {
		if maskedURL(ch.URL) || ch.URL == "" {
			// Unchanged (masked) or blank: restore the stored URL by index.
			if i < len(existing.Channels) && existing.Channels[i].URL != "" {
				ch.URL = existing.Channels[i].URL
			} else {
				continue // cannot restore; drop the channel
			}
		}
		if ch.URL == "" {
			continue
		}
		channels = append(channels, ch)
	}
	incoming.Channels = channels
	if err := s.alertsManager.UpdateConfig(incoming); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save alert config: " + err.Error()})
		return
	}
	// Return the freshly-saved (masked) config.
	s.getAlertsConfig(c)
}

// testAlerts sends a one-shot test message to a single channel (body: a
// ChannelConfig with a real URL). It validates the URL (SSRF policy) and
// reports the result without touching the alert state machine.
//
// @Summary      Test an alert channel
// @Description  Sends a test message to the provided channel.
// @Tags         alerts
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Test result"
// @Failure      400  {object}  map[string]interface{}  "Invalid channel"
// @Failure      502  {object}  map[string]interface{}  "Delivery failed"
// @Router       /alerts/test [post]
func (s *Server) testAlerts(c *gin.Context) {
	if s.alertsManager == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "alerts not configured"})
		return
	}
	var ch alerts.ChannelConfig
	if err := c.ShouldBindJSON(&ch); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid channel: " + err.Error()})
		return
	}
	if maskedURL(ch.URL) || ch.URL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel url required (a real, unmasked url)"})
		return
	}
	if err := s.alertsManager.SendTest(c.Request.Context(), ch); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "type": ch.Type})
}
