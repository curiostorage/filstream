/**
 * Shared FilStream wait spinner (rotating bounce dots, #18C8FF — favicon accent).
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { SPINNER_CSS } from "../services/filstream-constants.mjs";

let spinnerStylesInjected = false;

/** Idempotent: injects keyframes + spinner rules once. */
export function ensureSpinnerStyles() {
  if (typeof document === "undefined" || spinnerStylesInjected) return;
  spinnerStylesInjected = true;
  const el = document.createElement("style");
  el.textContent = SPINNER_CSS;
  document.head.appendChild(el);
}

/**
 * Lit-html fragment for the spinner.
 *
 * @param {{ size?: "sm" | "md" | "lg", className?: string }} [opts]
 */
export function spinnerLit(opts = {}) {
  ensureSpinnerStyles();
  const size = opts.size ?? "md";
  const sizeClass =
    size === "sm"
      ? "filstream-spinner--sm"
      : size === "lg"
        ? "filstream-spinner--lg"
        : size === "md"
          ? "filstream-spinner--md"
          : "";
  const cls = ["filstream-spinner", sizeClass, opts.className]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${cls} aria-hidden="true">
      <div class="filstream-spinner__dot filstream-spinner__dot--1"></div>
      <div class="filstream-spinner__dot filstream-spinner__dot--2"></div>
    </div>
  `;
}

/**
 * @param {{ size?: "sm" | "md" | "lg", className?: string }} [opts]
 * @returns {HTMLDivElement}
 */
export function createSpinnerElement(opts = {}) {
  ensureSpinnerStyles();
  const size = opts.size ?? "md";
  const sizeClass =
    size === "sm"
      ? "filstream-spinner--sm"
      : size === "lg"
        ? "filstream-spinner--lg"
        : "filstream-spinner--md";
  const wrap = document.createElement("div");
  wrap.className = ["filstream-spinner", sizeClass, opts.className]
    .filter(Boolean)
    .join(" ");
  wrap.setAttribute("aria-hidden", "true");
  const d1 = document.createElement("div");
  d1.className = "filstream-spinner__dot filstream-spinner__dot--1";
  const d2 = document.createElement("div");
  d2.className = "filstream-spinner__dot filstream-spinner__dot--2";
  wrap.append(d1, d2);
  return wrap;
}
