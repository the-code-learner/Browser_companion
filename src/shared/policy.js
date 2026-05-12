import { ACTION_TYPES, RISK_LEVELS } from "./schemas.js";

const LOW_RISK_ACTIONS = new Set([
  ACTION_TYPES.OBSERVE_PAGE,
  ACTION_TYPES.GET_VISIBLE_TEXT,
  ACTION_TYPES.GET_DOM_SNAPSHOT,
  ACTION_TYPES.GET_FORMS,
  ACTION_TYPES.GET_LINKS,
  ACTION_TYPES.GET_BUTTONS,
  ACTION_TYPES.CAPTURE_VIEWPORT,
  ACTION_TYPES.CAPTURE_NUMBERED_OVERLAY,
  ACTION_TYPES.HTTP_REQUEST,
  ACTION_TYPES.WEB_SEARCH,
  ACTION_TYPES.OPEN_URL,
  ACTION_TYPES.OPEN_URL_NEW_TAB,
  ACTION_TYPES.SCROLL_TO_ELEMENT,
  ACTION_TYPES.SCROLL_BY,
  ACTION_TYPES.WAIT_FOR_PAGE_CHANGE,
  ACTION_TYPES.HIGHLIGHT_ELEMENT,
  ACTION_TYPES.CLEAR_HIGHLIGHTS,
  ACTION_TYPES.ASK_USER,
  ACTION_TYPES.STOP_FOR_HUMAN
]);

const MEDIUM_RISK_ACTIONS = new Set([
  ACTION_TYPES.FOCUS_ELEMENT,
  ACTION_TYPES.GO_BACK,
  ACTION_TYPES.FILL_FIELD,
  ACTION_TYPES.SELECT_OPTION,
  ACTION_TYPES.TOGGLE_CHECKBOX,
  ACTION_TYPES.SET_RADIO,
  ACTION_TYPES.UPLOAD_FILE_TO_FIELD,
  ACTION_TYPES.CLICK_ELEMENT,
  ACTION_TYPES.CLICK_OVERLAY_NUMBER
]);

const SUBMIT_WORDS = /\b(submit|send|publish|delete|remove|buy|purchase|pay|accept|agree|sign|authorize|confirm order|continue and submit|finalize|invia|accetta|conferma|procedi)\b/i;
const SENSITIVE_WORDS = /\b(password|passcode|card|cvv|cvc|iban|ssn|social security|tax id|vat|passport|identity|health|medical|legal representative)\b/i;
const BLOCKED_WORDS = /\b(captcha|2fa|mfa|one-time code|otp|bypass access|circumvent)\b/i;

export function classifyAction(action) {
  const text = JSON.stringify(action || {});

  if (BLOCKED_WORDS.test(text)) {
    return RISK_LEVELS.BLOCKED;
  }

  if (SENSITIVE_WORDS.test(text)) {
    return RISK_LEVELS.SENSITIVE;
  }

  if (isSearchSubmitAction(action)) {
    return RISK_LEVELS.LOW;
  }

  if (SUBMIT_WORDS.test(text)) {
    return RISK_LEVELS.HIGH;
  }

  if (action?.type === ACTION_TYPES.CLICK_ELEMENT && action?.target?.role === "link") {
    return RISK_LEVELS.LOW;
  }

  if (LOW_RISK_ACTIONS.has(action?.type)) {
    return RISK_LEVELS.LOW;
  }

  if (MEDIUM_RISK_ACTIONS.has(action?.type)) {
    return RISK_LEVELS.MEDIUM;
  }

  return RISK_LEVELS.BLOCKED;
}

function isSearchSubmitAction(action) {
  if (action?.type !== ACTION_TYPES.CLICK_ELEMENT) {
    return false;
  }

  const target = action?.target || {};
  const combined = [
    target.agent_id,
    target.role,
    target.name,
    ...(Array.isArray(target.selector_candidates) ? target.selector_candidates : [])
  ].join(" ");

  const normalized = String(combined || "").toLowerCase();
  const searchWords = /\b(search|find|lookup|cerca|ricerca)\b/i;
  const searchSelectorHints = /\b(search|find|lookup|cerca|ricerca)\b|nav-search-submit-button/i;

  return searchSelectorHints.test(normalized) && (target.role === "button" || searchWords.test(normalized));
}

export function validateActionPlan(plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const results = actions.map((action, index) => {
    const risk = classifyAction(action);
    return {
      index,
      actionType: action?.type || "unknown",
      risk,
      allowed: risk !== RISK_LEVELS.BLOCKED && action?.type !== ACTION_TYPES.UPLOAD_FILE_TO_FIELD,
      requiresConfirmation: risk !== RISK_LEVELS.LOW,
      reason: action?.type === ACTION_TYPES.UPLOAD_FILE_TO_FIELD
        ? "File upload fields must be completed by the user through the browser file picker."
        : getPolicyReason(risk)
    };
  });

  return {
    type: "policy_result",
    allowed: results.every((result) => result.allowed),
    requiresConfirmation: results.some((result) => result.requiresConfirmation),
    results
  };
}

function getPolicyReason(risk) {
  if (risk === RISK_LEVELS.LOW) {
    return "Read-only or reversible browser assistance.";
  }

  if (risk === RISK_LEVELS.MEDIUM) {
    return "The action can change page state and needs user confirmation.";
  }

  if (risk === RISK_LEVELS.HIGH) {
    return "The action may submit, publish, delete, pay, or accept something.";
  }

  if (risk === RISK_LEVELS.SENSITIVE) {
    return "The action touches sensitive personal, financial, legal, or security data.";
  }

  return "The action is outside the allowed browser automation policy.";
}
