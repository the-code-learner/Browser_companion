export const MESSAGE_TYPES = Object.freeze({
  OBSERVE_ACTIVE_TAB: "observe_active_tab",
  PAGE_OBSERVATION: "page_observation",
  NATIVE_HEALTH: "native_health",
  NATIVE_STATUS: "native_status",
  CONNECT_CODEX: "connect_codex",
  INSTALL_PROVIDER: "install_provider",
  INSTALL_NODEJS: "install_nodejs",
  HTTP_PROVIDER_TEST: "http_provider_test",
  HTTP_PROVIDER_UNLOAD: "http_provider_unload",
  EXTRACT_ATTACHMENT: "extract_attachment",
  HTTP_REQUEST: "http_request",
  WEB_SEARCH: "web_search",
  USER_MEMORY_GET: "user_memory_get",
  USER_MEMORY_SAVE: "user_memory_save",
  USER_MEMORY_DELETE: "user_memory_delete",
  AGENT_REQUEST: "agent_request",
  SYNTHESIS_REQUEST: "synthesis_request",
  AGENT_RESPONSE: "agent_response",
  VALIDATE_ACTION_PLAN: "validate_action_plan",
  POLICY_RESULT: "policy_result",
  DEV_WATCH_STATUS: "dev_watch_status",
  EXECUTE_ACTION_PLAN: "execute_action_plan",
  EXECUTION_RESULT: "execution_result"
});

export const NATIVE_HOST_NAME = "com.browser_companion.codex_bridge";

export function makeEnvelope(type, payload = {}) {
  return {
    type,
    payload,
    sentAt: new Date().toISOString()
  };
}
