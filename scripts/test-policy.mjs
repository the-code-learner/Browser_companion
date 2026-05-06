import assert from "node:assert/strict";
import { validateActionPlan } from "../src/shared/policy.js";

const lowRiskPlan = {
  type: "agent_plan",
  actions: [
    {
      type: "highlight_element",
      target: {
        agent_id: "el_1",
        role: "button",
        name: "Continue"
      },
      reason: "Show the target to the user."
    }
  ]
};

const fillPlan = {
  type: "agent_plan",
  actions: [
    {
      type: "fill_field",
      target: {
        agent_id: "el_2",
        role: "textbox",
        name: "Company name"
      },
      value: "Browser Companion",
      reason: "Fill a normal text field."
    }
  ]
};

const linkClickPlan = {
  type: "agent_plan",
  actions: [
    {
      type: "click_element",
      target: {
        agent_id: "link_1",
        role: "link",
        name: "Deployment"
      },
      reason: "Open a normal documentation link."
    }
  ]
};

const openUrlPlan = {
  type: "agent_plan",
  actions: [
    {
      type: "open_url",
      target: {
        agent_id: "",
        role: "",
        name: ""
      },
      value: "https://www.google.com/search?q=ciao",
      reason: "Open a normal web URL requested by the user."
    }
  ]
};

const blockedPlan = {
  type: "agent_plan",
  actions: [
    {
      type: "fill_field",
      target: {
        agent_id: "el_3",
        role: "textbox",
        name: "Password"
      },
      value: "secret",
      reason: "Password entry."
    }
  ]
};

assert.equal(validateActionPlan(lowRiskPlan).requiresConfirmation, false);
assert.equal(validateActionPlan(linkClickPlan).requiresConfirmation, false);
assert.equal(validateActionPlan(openUrlPlan).requiresConfirmation, false);
assert.equal(validateActionPlan(fillPlan).requiresConfirmation, true);
assert.equal(validateActionPlan(blockedPlan).allowed, true);
assert.equal(validateActionPlan(blockedPlan).results[0].risk, "sensitive");

const captchaPlan = {
  type: "agent_plan",
  actions: [
    {
      type: "click_element",
      target: {
        agent_id: "el_4",
        role: "button",
        name: "Solve CAPTCHA"
      },
      reason: "CAPTCHA solving."
    }
  ]
};

assert.equal(validateActionPlan(captchaPlan).allowed, false);

console.log("Policy tests passed.");
