export const MESSAGE_TYPES = Object.freeze({
  OBSERVE_ACTIVE_TAB: "observe_active_tab",
  PAGE_OBSERVATION: "page_observation",
  NATIVE_HEALTH: "native_health",
  NATIVE_STATUS: "native_status",
  VALIDATE_ACTION_PLAN: "validate_action_plan",
  POLICY_RESULT: "policy_result"
});

export const NATIVE_HOST_NAME = "com.browser_companion.codex_bridge";

export function makeEnvelope(type, payload = {}) {
  return {
    type,
    payload,
    sentAt: new Date().toISOString()
  };
}

