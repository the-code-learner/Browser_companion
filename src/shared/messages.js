export const MESSAGE_TYPES = Object.freeze({
  OBSERVE_ACTIVE_TAB: "observe_active_tab",
  PAGE_OBSERVATION: "page_observation",
  NATIVE_HEALTH: "native_health",
  NATIVE_STATUS: "native_status",
  CONNECT_CODEX: "connect_codex",
  EXTRACT_ATTACHMENT: "extract_attachment",
  AGENT_REQUEST: "agent_request",
  AGENT_RESPONSE: "agent_response",
  VALIDATE_ACTION_PLAN: "validate_action_plan",
  POLICY_RESULT: "policy_result",
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
