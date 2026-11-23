// Package litellmconfig reads the routing part of a LiteLLM proxy
// config.yaml: which model groups exist, which deployments serve each, the
// names that are aliases of a group, the fallbacks between groups and the
// router's retry and cooldown settings.
//
// It is what LiteLLM was told to do, as opposed to what its metrics say it
// did; the Gateway page draws one over the other. Only the fields listed
// here are read: API keys, prices and every other setting stay in the file.
package litellmconfig

import (
	"fmt"
	"net/url"
	"sort"
	"strings"

	"sigs.k8s.io/yaml"
)

// Deployment is one backend of a model group.
type Deployment struct {
	Model    string `json:"model"`             // litellm_params.model, e.g. hosted_vllm/Qwen/Qwen3.5-9B
	Provider string `json:"provider"`          // custom_llm_provider, else the prefix of Model
	APIBase  string `json:"apiBase,omitempty"` // scheme, host and path only
}

// ModelGroup is a model_name callers can ask for and the deployments LiteLLM
// balances it over. A name with "*" is a wildcard group.
type ModelGroup struct {
	Name        string       `json:"name"`
	Wildcard    bool         `json:"wildcard,omitempty"`
	Deployments []Deployment `json:"deployments"`
}

// Alias is another name for a model group (router_settings.model_group_alias).
type Alias struct {
	Name   string `json:"name"`
	Target string `json:"target"`
	Hidden bool   `json:"hidden,omitempty"`
}

// Fallback kinds: which failures the list applies to.
const (
	KindGeneral       = "general"        // any error left after retries
	KindContextWindow = "context_window" // the prompt does not fit the model
	KindContentPolicy = "content_policy" // the provider refused the content
)

// Fallback is the ordered list of groups tried when From fails.
type Fallback struct {
	From string   `json:"from"`
	To   []string `json:"to"`
	Kind string   `json:"kind"`
}

// Settings are the router settings that decide when a fallback happens.
// Pointers are nil when the file does not set them (LiteLLM's default
// applies).
type Settings struct {
	NumRetries       *float64 `json:"numRetries"`
	AllowedFails     *float64 `json:"allowedFails"`
	CooldownSeconds  *float64 `json:"cooldownSeconds"`
	TimeoutSeconds   *float64 `json:"timeoutSeconds"`
	StreamTimeout    *float64 `json:"streamTimeoutSeconds"`
	RoutingStrategy  string   `json:"routingStrategy,omitempty"`
	DefaultFallbacks []string `json:"defaultFallbacks,omitempty"` // for groups with no fallback of their own
}

// Issue is something in the config an operator would want to know.
type Issue struct {
	Severity string   `json:"severity"` // error | warn | info
	Kind     string   `json:"kind"`     // unknown-target | unknown-source | unknown-alias-target | self | no-fallback | shared-target
	Text     string   `json:"text"`
	Subjects []string `json:"subjects,omitempty"` // the groups it is about
}

// Config is the routing part of a LiteLLM config.
type Config struct {
	Groups    []ModelGroup `json:"groups"`
	Aliases   []Alias      `json:"aliases"`
	Fallbacks []Fallback   `json:"fallbacks"`
	Settings  Settings     `json:"settings"`
	Issues    []Issue      `json:"issues"`
}

// The shapes below are the subset of config.yaml that is read.
type rawFile struct {
	ModelList []struct {
		ModelName     string `json:"model_name"`
		LitellmParams struct {
			Model    string `json:"model"`
			APIBase  string `json:"api_base"`
			Provider string `json:"custom_llm_provider"`
		} `json:"litellm_params"`
	} `json:"model_list"`
	RouterSettings  rawRouting `json:"router_settings"`
	LitellmSettings rawRouting `json:"litellm_settings"`
}

type rawRouting struct {
	Fallbacks              []map[string][]string `json:"fallbacks"`
	ContextWindowFallbacks []map[string][]string `json:"context_window_fallbacks"`
	ContentPolicyFallbacks []map[string][]string `json:"content_policy_fallbacks"`
	DefaultFallbacks       []string              `json:"default_fallbacks"`
	ModelGroupAlias        map[string]any        `json:"model_group_alias"`
	NumRetries             *float64              `json:"num_retries"`
	AllowedFails           *float64              `json:"allowed_fails"`
	CooldownTime           *float64              `json:"cooldown_time"`
	Timeout                *float64              `json:"timeout"`
	StreamTimeout          *float64              `json:"stream_timeout"`
	RequestTimeout         *float64              `json:"request_timeout"`
	RoutingStrategy        string                `json:"routing_strategy"`
}

// Parse reads a LiteLLM config.yaml and checks its routing (Issues).
func Parse(data []byte) (*Config, error) {
	var raw rawFile
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("litellmconfig: %w", err)
	}
	cfg := &Config{Groups: []ModelGroup{}, Aliases: []Alias{}, Fallbacks: []Fallback{}, Issues: []Issue{}}

	byName := map[string]int{}
	for _, m := range raw.ModelList {
		if m.ModelName == "" {
			continue
		}
		i, ok := byName[m.ModelName]
		if !ok {
			i = len(cfg.Groups)
			byName[m.ModelName] = i
			cfg.Groups = append(cfg.Groups, ModelGroup{Name: m.ModelName, Wildcard: strings.Contains(m.ModelName, "*"), Deployments: []Deployment{}})
		}
		p := m.LitellmParams
		cfg.Groups[i].Deployments = append(cfg.Groups[i].Deployments, Deployment{
			Model: p.Model, Provider: providerOf(p.Provider, p.Model), APIBase: cleanURL(p.APIBase),
		})
	}

	// router_settings is what the router reads; litellm_settings is the older
	// place for the same keys and fills in what the first leaves out.
	r, l := raw.RouterSettings, raw.LitellmSettings
	for name, v := range mergeAliases(l.ModelGroupAlias, r.ModelGroupAlias) {
		cfg.Aliases = append(cfg.Aliases, aliasOf(name, v))
	}
	sort.Slice(cfg.Aliases, func(i, j int) bool { return cfg.Aliases[i].Name < cfg.Aliases[j].Name })

	seen := map[string]bool{}
	add := func(kind string, lists ...[]map[string][]string) {
		for _, list := range lists {
			for _, entry := range list {
				for _, from := range sortedKeys(entry) {
					if key := kind + "\x00" + from; !seen[key] && len(entry[from]) > 0 {
						seen[key] = true
						cfg.Fallbacks = append(cfg.Fallbacks, Fallback{From: from, To: entry[from], Kind: kind})
					}
				}
			}
		}
	}
	add(KindGeneral, r.Fallbacks, l.Fallbacks)
	add(KindContextWindow, r.ContextWindowFallbacks, l.ContextWindowFallbacks)
	add(KindContentPolicy, r.ContentPolicyFallbacks, l.ContentPolicyFallbacks)

	cfg.Settings = Settings{
		NumRetries:       first(r.NumRetries, l.NumRetries),
		AllowedFails:     first(r.AllowedFails, l.AllowedFails),
		CooldownSeconds:  first(r.CooldownTime, l.CooldownTime),
		TimeoutSeconds:   first(r.Timeout, l.Timeout, r.RequestTimeout, l.RequestTimeout),
		StreamTimeout:    first(r.StreamTimeout, l.StreamTimeout),
		RoutingStrategy:  firstString(r.RoutingStrategy, l.RoutingStrategy),
		DefaultFallbacks: firstList(r.DefaultFallbacks, l.DefaultFallbacks),
	}
	cfg.Issues = cfg.check()
	return cfg, nil
}

func mergeAliases(maps ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, m := range maps {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

// aliasOf reads an alias value: a group name, or {model, hidden}.
func aliasOf(name string, v any) Alias {
	a := Alias{Name: name}
	switch t := v.(type) {
	case string:
		a.Target = t
	case map[string]any:
		a.Target, _ = t["model"].(string)
		a.Hidden, _ = t["hidden"].(bool)
	}
	return a
}

// providerOf is the provider LiteLLM routes a deployment to: set
// explicitly, else the first segment of the model ("hosted_vllm/…").
func providerOf(explicit, model string) string {
	if explicit != "" {
		return explicit
	}
	if i := strings.Index(model, "/"); i > 0 {
		return model[:i]
	}
	return ""
}

// cleanURL keeps a URL's scheme, host and path. An api_base may carry a
// user, password or key in its query; none of that is needed to draw it.
// A value read from the environment ("os.environ/NAME") is kept as is.
func cleanURL(s string) string {
	if s == "" || strings.HasPrefix(s, "os.environ/") {
		return s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return ""
	}
	return (&url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path}).String()
}

func first(vals ...*float64) *float64 {
	for _, v := range vals {
		if v != nil {
			return v
		}
	}
	return nil
}

func firstString(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstList(vals ...[]string) []string {
	for _, v := range vals {
		if len(v) > 0 {
			return v
		}
	}
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Resolve returns the model group a requested name is served by: the group
// of that name, the group an alias points to, or the wildcard group whose
// pattern matches ("" when none does).
func (c *Config) Resolve(name string) string {
	for _, a := range c.Aliases {
		if a.Name == name && a.Target != "" {
			name = a.Target
			break
		}
	}
	wildcard := ""
	for _, g := range c.Groups {
		if g.Name == name {
			return g.Name
		}
		// The most specific (longest) matching pattern wins, as in LiteLLM.
		if g.Wildcard && matchWildcard(g.Name, name) && len(g.Name) > len(wildcard) {
			wildcard = g.Name
		}
	}
	return wildcard
}

// matchWildcard reports whether name matches a pattern where each "*"
// stands for any run of characters.
func matchWildcard(pattern, name string) bool {
	parts := strings.Split(pattern, "*")
	if !strings.HasPrefix(name, parts[0]) {
		return false
	}
	name = name[len(parts[0]):]
	for i := 1; i < len(parts); i++ {
		p := parts[i]
		if i == len(parts)-1 {
			return strings.HasSuffix(name, p)
		}
		j := strings.Index(name, p)
		if j < 0 {
			return false
		}
		name = name[j+len(p):]
	}
	return name == ""
}

// check lists what is wrong or risky in the routing.
func (c *Config) check() []Issue {
	issues := []Issue{}
	for _, a := range c.Aliases {
		if a.Target == "" || c.Resolve(a.Target) == "" {
			issues = append(issues, Issue{Severity: "error", Kind: "unknown-alias-target", Subjects: []string{a.Name},
				Text: fmt.Sprintf("Alias %s points to %q, which is not in model_list: requests for it fail.", a.Name, a.Target)})
		}
	}

	hasFallback := map[string]bool{}
	targets := map[string][]string{} // general fallback target → the groups that use it
	for _, f := range c.Fallbacks {
		src := c.Resolve(f.From)
		if src == "" {
			issues = append(issues, Issue{Severity: "warn", Kind: "unknown-source", Subjects: []string{f.From},
				Text: fmt.Sprintf("Fallback for %s: no model group or alias has that name, so it never applies.", f.From)})
		} else if f.Kind == KindGeneral {
			hasFallback[src] = true
			// A fallback keyed by an alias or a wildcard match also covers
			// the name it was written for.
			hasFallback[f.From] = true
		}
		for _, to := range f.To {
			switch dst := c.Resolve(to); {
			case dst == "":
				issues = append(issues, Issue{Severity: "error", Kind: "unknown-target", Subjects: []string{f.From, to},
					Text: fmt.Sprintf("%s falls back to %q, which is not in model_list: that fallback fails.", f.From, to)})
			case dst == src && src != "":
				issues = append(issues, Issue{Severity: "warn", Kind: "self", Subjects: []string{f.From},
					Text: fmt.Sprintf("%s falls back to itself: the same deployments are tried again.", f.From)})
			default:
				if f.Kind == KindGeneral && src != "" && !contains(targets[dst], src) {
					targets[dst] = append(targets[dst], src)
				}
			}
		}
	}

	if len(c.Settings.DefaultFallbacks) == 0 {
		var without []string
		for _, g := range c.Groups {
			// A group that only exists as a fallback target is the end of
			// the line by design; a wildcard cannot be keyed in fallbacks.
			if !hasFallback[g.Name] && len(targets[g.Name]) == 0 && !g.Wildcard {
				without = append(without, g.Name)
			}
		}
		if len(without) > 0 && len(c.Fallbacks) > 0 {
			issues = append(issues, Issue{Severity: "warn", Kind: "no-fallback", Subjects: without,
				Text: fmt.Sprintf("%s no fallback: when %s fail, the request fails.", countOf(len(without), "model group has", "model groups have"), itThey(len(without)))})
		}
	}
	for _, dst := range sortedKeys(targets) {
		if users := targets[dst]; len(users) >= 2 {
			sort.Strings(users)
			issues = append(issues, Issue{Severity: "info", Kind: "shared-target", Subjects: append([]string{dst}, users...),
				Text: fmt.Sprintf("%d model groups fall back to %s: if it is down, none of them has a fallback.", len(users), dst)})
		}
	}
	return issues
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func countOf(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

func itThey(n int) string {
	if n == 1 {
		return "its deployments"
	}
	return "their deployments"
}
