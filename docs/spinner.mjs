/**
 * Shared FilStream wait spinner (rotating bounce dots, #18C8FF — favicon accent).
 */
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import {
  SPINNER_CSS,
  SPINNER_STYLE_ID as STYLE_ID,
} from "./filstream-constants.mjs";

/** Idempotent: injects keyframes + spinner rules once. */
export function ensureSpinnerStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
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
  const holder = document.createElement("div");
  render(spinnerLit(opts), holder);
  return /** @type {HTMLDivElement} */ (holder.firstElementChild);
}
