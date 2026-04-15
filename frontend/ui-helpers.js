export const formatAmount = (value) => {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-";
};

export const setText = (id, value) => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};

export const setFeedback = (id, value, tone = "neutral") => {
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = value;
  element.dataset.tone = tone;
};

export const setOverallStatus = (label, className) => {
  const pill = document.getElementById("system-pill");
  if (!pill) return;
  pill.textContent = label;
  pill.className = `status-pill ${className}`;
};

export const setActionStatus = (label, className) => {
  const pill = document.getElementById("action-pill");
  if (!pill) return;
  pill.textContent = label;
  pill.className = `status-pill ${className}`;
};

const buttonLabels = new WeakMap();
const toastTimeouts = new WeakMap();

export const setButtonBusy = (button, busy, busyLabel = "Working...") => {
  if (!button) return;

  if (!buttonLabels.has(button)) {
    buttonLabels.set(button, button.textContent);
  }

  button.disabled = busy;
  button.dataset.busy = busy ? "true" : "false";
  button.textContent = busy ? busyLabel : buttonLabels.get(button);
};

export const showToast = (message, tone = "neutral") => {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.tone = tone;
  toast.textContent = message;
  stack.appendChild(toast);

  requestAnimationFrame(() => {
    toast.dataset.visible = "true";
  });

  const timeout = setTimeout(() => {
    toast.dataset.visible = "false";
    setTimeout(() => {
      toast.remove();
      toastTimeouts.delete(toast);
    }, 220);
  }, 3400);

  toastTimeouts.set(toast, timeout);
};
