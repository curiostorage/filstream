/**
 * Shared FilStream wait spinner (rotating bounce dots, #18C8FF — favicon accent).
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";

const STYLE_ID = "filstream-spinner-styles";

const SPINNER_CSS = `
.filstream-spinner {
  --fs-spin-size: 2.5rem;
  margin: 0;
  width: var(--fs-spin-size);
  height: var(--fs-spin-size);
  position: relative;
  text-align: center;
  flex-shrink: 0;
  animation: filstream-sk-rotate 2s infinite linear;
}
.filstream-spinner--sm {
  --fs-spin-size: 1.25rem;
}
.filstream-spinner--md {
  --fs-spin-size: 1.75rem;
}
.filstream-spinner--lg {
  --fs-spin-size: 2.25rem;
}
.filstream-spinner__dot {
  width: 60%;
  height: 60%;
  position: absolute;
  left: 0;
  right: 0;
  margin-left: auto;
  margin-right: auto;
  background-color: #18C8FF;
  border-radius: 100%;
  animation: filstream-sk-bounce 2s infinite ease-in-out;
}
.filstream-spinner__dot--1 {
  top: 0;
}
.filstream-spinner__dot--2 {
  top: auto;
  bottom: 0;
  animation-delay: -1s;
}

@keyframes filstream-sk-rotate {
  100% {
    transform: rotate(360deg);
  }
}
@keyframes filstream-sk-bounce {
  0%,
  100% {
    transform: scale(0);
  }
  50% {
    transform: scale(1);
  }
}
`;

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
