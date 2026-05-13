export const ACTION_TYPES = Object.freeze({
  OBSERVE_PAGE: "observe_page",
  OBSERVE_KNOWN_TAB: "observe_known_tab",
  GET_VISIBLE_TEXT: "get_visible_text",
  GET_DOM_SNAPSHOT: "get_dom_snapshot",
  GET_FORMS: "get_forms",
  GET_LINKS: "get_links",
  GET_BUTTONS: "get_buttons",
  CAPTURE_VIEWPORT: "capture_viewport",
  CAPTURE_NUMBERED_OVERLAY: "capture_numbered_overlay",
  HTTP_REQUEST: "http_request",
  WEB_SEARCH: "web_search",
  OPEN_URL: "open_url",
  OPEN_URL_NEW_TAB: "open_url_new_tab",
  SCROLL_TO_ELEMENT: "scroll_to_element",
  SCROLL_BY: "scroll_by",
  WAIT_FOR_PAGE_CHANGE: "wait_for_page_change",
  GO_BACK: "go_back",
  FOCUS_ELEMENT: "focus_element",
  HIGHLIGHT_ELEMENT: "highlight_element",
  CLEAR_HIGHLIGHTS: "clear_highlights",
  FILL_FIELD: "fill_field",
  SELECT_OPTION: "select_option",
  TOGGLE_CHECKBOX: "toggle_checkbox",
  SET_RADIO: "set_radio",
  UPLOAD_FILE_TO_FIELD: "upload_file_to_field",
  CLICK_ELEMENT: "click_element",
  CLICK_OVERLAY_NUMBER: "click_overlay_number",
  REQUEST_CONFIRMATION: "request_confirmation",
  ASK_USER: "ask_user",
  STOP_FOR_HUMAN: "stop_for_human"
});

export const RISK_LEVELS = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  SENSITIVE: "sensitive",
  BLOCKED: "blocked"
});

export function createObservation(tab, pageData) {
  return {
    type: "page_observation",
    tab,
    viewport: pageData.viewport,
    visible_text: pageData.visibleText,
    headings: pageData.headings,
    links: pageData.links,
    buttons: pageData.buttons,
    forms: pageData.forms,
    interactive_elements: pageData.interactiveElements,
    page_outline: pageData.pageOutline || null,
    structured_items: pageData.structuredItems || [],
    content_blocks: pageData.contentBlocks || [],
    capturedAt: new Date().toISOString()
  };
}

export function isAgentPlan(value) {
  return Boolean(
    value &&
      value.type === "agent_plan" &&
      typeof value.goal === "string" &&
      Array.isArray(value.actions)
  );
}
