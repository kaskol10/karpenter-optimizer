package litellmconfig

import (
	"encoding/json"
	"strings"
	"testing"
)

// The shape of a real proxy config: wildcard groups, a load-balanced group,
// renamed aliases, fallbacks to an external API and secrets that must not
// come out.
const sample = `
general_settings:
  master_key: sk-master-SECRET
litellm_settings:
  request_timeout: 600
  context_window_fallbacks:
  - acme/small:
    - acme/large
model_list:
- model_name: acme/*
  litellm_params:
    model: hosted_vllm/*
    api_base: https://user:SECRET@vllm.acme.example/v1?key=SECRET
    api_key: sk-SECRET
    input_cost_per_token: 1.0e-07
- model_name: acme/small
  litellm_params:
    model: hosted_vllm/Qwen/Small
    api_base: https://vllm.acme.example/v1/
- model_name: acme/small
  litellm_params:
    model: hosted_vllm/Qwen/Small
    api_base: https://vllm-b.acme.example/v1/
- model_name: acme/large
  litellm_params:
    model: hosted_vllm/Qwen/Large
    api_base: os.environ/LARGE_BASE
- model_name: acme/embed
  litellm_params:
    model: hosted_vllm/Qwen/Embed
- model_name: together/small
  litellm_params:
    model: openai/Qwen/Small
    api_base: https://api.together.xyz/v1/
    custom_llm_provider: together_ai
- model_name: bedrock/haiku
  litellm_params:
    model: bedrock/us.anthropic.claude-haiku
router_settings:
  num_retries: 0
  allowed_fails: 60
  cooldown_time: 5
  timeout: 60
  stream_timeout: 120
  fallbacks:
  - acme/small:
    - together/small
  - acme/large:
    - together/small
    - acme/missing
  - acme/gone:
    - together/small
  - bedrock/haiku:
    - bedrock/haiku
  model_group_alias:
    acme/old-small: acme/small
    acme/hidden:
      model: acme/large
      hidden: true
    acme/broken: nowhere/model
`

func TestParse(t *testing.T) {
	cfg, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(cfg)
	if strings.Contains(string(out), "SECRET") || strings.Contains(string(out), "cost") {
		t.Fatalf("secrets or prices leaked: %s", out)
	}

	if len(cfg.Groups) != 6 {
		t.Fatalf("groups: %+v", cfg.Groups)
	}
	wild, small, large, together := cfg.Groups[0], cfg.Groups[1], cfg.Groups[2], cfg.Groups[4]
	if !wild.Wildcard || wild.Deployments[0].APIBase != "https://vllm.acme.example/v1" || wild.Deployments[0].Provider != "hosted_vllm" {
		t.Errorf("wildcard group %+v", wild)
	}
	if len(small.Deployments) != 2 || small.Deployments[1].APIBase != "https://vllm-b.acme.example/v1/" {
		t.Errorf("load-balanced group %+v", small)
	}
	if large.Deployments[0].APIBase != "os.environ/LARGE_BASE" {
		t.Errorf("env api_base %+v", large)
	}
	if together.Deployments[0].Provider != "together_ai" {
		t.Errorf("explicit provider %+v", together)
	}

	if len(cfg.Aliases) != 3 || cfg.Aliases[1] != (Alias{Name: "acme/hidden", Target: "acme/large", Hidden: true}) ||
		cfg.Aliases[2] != (Alias{Name: "acme/old-small", Target: "acme/small"}) {
		t.Errorf("aliases %+v", cfg.Aliases)
	}

	if len(cfg.Fallbacks) != 5 {
		t.Fatalf("fallbacks %+v", cfg.Fallbacks)
	}
	if f := cfg.Fallbacks[1]; f.From != "acme/large" || f.Kind != KindGeneral || len(f.To) != 2 || f.To[1] != "acme/missing" {
		t.Errorf("ordered fallback %+v", f)
	}
	if f := cfg.Fallbacks[4]; f.From != "acme/small" || f.Kind != KindContextWindow || f.To[0] != "acme/large" {
		t.Errorf("context window fallback from litellm_settings %+v", f)
	}

	s := cfg.Settings
	if *s.NumRetries != 0 || *s.AllowedFails != 60 || *s.CooldownSeconds != 5 || *s.TimeoutSeconds != 60 || *s.StreamTimeout != 120 {
		t.Errorf("settings %+v", s)
	}
}

func TestResolve(t *testing.T) {
	cfg, _ := Parse([]byte(sample))
	for name, want := range map[string]string{
		"acme/small":     "acme/small",
		"acme/old-small": "acme/small", // alias
		"acme/anything":  "acme/*",     // wildcard
		"together/small": "together/small",
		"other/model":    "",
		"acme/broken":    "",
	} {
		if got := cfg.Resolve(name); got != want {
			t.Errorf("Resolve(%q) = %q, want %q", name, got, want)
		}
	}
	for _, c := range []struct {
		pattern, name string
		want          bool
	}{
		{"a/*", "a/b/c", true}, {"a/*", "b/c", false}, {"*/x", "a/x", true}, {"a/*-fp8", "a/m-fp8", true},
		{"a/*-fp8", "a/m", false}, {"a/*/b/*", "a/1/b/2", true}, {"a/*/b/*", "a/1/c/2", false},
	} {
		if got := matchWildcard(c.pattern, c.name); got != c.want {
			t.Errorf("matchWildcard(%q, %q) = %v", c.pattern, c.name, got)
		}
	}
}

func TestIssues(t *testing.T) {
	cfg, _ := Parse([]byte(sample))
	byKind := map[string][]Issue{}
	for _, i := range cfg.Issues {
		byKind[i.Kind] = append(byKind[i.Kind], i)
	}
	if got := byKind["unknown-alias-target"]; len(got) != 1 || got[0].Subjects[0] != "acme/broken" || got[0].Severity != "error" {
		t.Errorf("unknown alias target: %+v", got)
	}
	// acme/missing is matched by the acme/* wildcard, so it is not unknown.
	if got := byKind["unknown-target"]; len(got) != 0 {
		t.Errorf("unknown target: %+v", got)
	}
	// acme/gone too: the wildcard serves it.
	if got := byKind["unknown-source"]; len(got) != 0 {
		t.Errorf("unknown source: %+v", got)
	}
	if got := byKind["self"]; len(got) != 1 || got[0].Subjects[0] != "bedrock/haiku" {
		t.Errorf("self fallback: %+v", got)
	}
	// acme/embed has none. together/small is only a target; acme/* is a wildcard.
	if got := byKind["no-fallback"]; len(got) != 1 || len(got[0].Subjects) != 1 || got[0].Subjects[0] != "acme/embed" ||
		!strings.HasPrefix(got[0].Text, "1 model group has no fallback") {
		t.Errorf("no fallback: %+v", got)
	}
	if got := byKind["shared-target"]; len(got) != 1 || got[0].Subjects[0] != "together/small" || len(got[0].Subjects) != 4 {
		t.Errorf("shared target: %+v", got)
	}
}

func TestIssuesWithoutAWildcard(t *testing.T) {
	cfg, err := Parse([]byte(`
model_list:
- model_name: a
  litellm_params: {model: openai/a}
- model_name: b
  litellm_params: {model: openai/b}
- model_name: c
  litellm_params: {model: openai/c}
litellm_settings:
  fallbacks:
  - a: [nope]
  - ghost: [b]
`))
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]Issue{}
	for _, i := range cfg.Issues {
		kinds[i.Kind] = i
	}
	if i := kinds["unknown-target"]; i.Severity != "error" || !strings.Contains(i.Text, `"nope"`) {
		t.Errorf("unknown target: %+v", cfg.Issues)
	}
	if i := kinds["unknown-source"]; !strings.Contains(i.Text, "ghost") {
		t.Errorf("unknown source: %+v", cfg.Issues)
	}
	if i := kinds["no-fallback"]; len(i.Subjects) != 2 || !strings.HasPrefix(i.Text, "2 model groups have no fallback") {
		t.Errorf("no fallback: %+v", i)
	}
}

func TestDefaultFallbacksAndEmpty(t *testing.T) {
	cfg, _ := Parse([]byte(`
model_list:
- model_name: a
  litellm_params: {model: openai/a}
- model_name: b
  litellm_params: {model: openai/b}
litellm_settings:
  default_fallbacks: [b]
  fallbacks:
  - a: [b]
`))
	for _, i := range cfg.Issues {
		if i.Kind == "no-fallback" {
			t.Errorf("default_fallbacks covers every group: %+v", i)
		}
	}
	// No fallbacks at all is a choice, not a list of warnings.
	plain, err := Parse([]byte("model_list:\n- model_name: a\n  litellm_params: {model: openai/a}\n"))
	if err != nil || len(plain.Issues) != 0 || plain.Fallbacks == nil || plain.Aliases == nil {
		t.Errorf("plain config: %+v %v", plain, err)
	}
	if _, err := Parse([]byte("model_list: {nope")); err == nil {
		t.Error("want an error for broken YAML")
	}
	if got := cleanURL("not a url"); got != "" {
		t.Errorf("cleanURL kept %q", got)
	}
}
