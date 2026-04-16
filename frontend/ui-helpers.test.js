import test from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, html, rawHtml } from "./ui-helpers.js";

test("escapeHtml escapes the five HTML-significant characters", () => {
  assert.equal(escapeHtml("<script>\"&'"), "&lt;script&gt;&quot;&amp;&#39;");
});

test("escapeHtml coerces nullish to empty string", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("escapeHtml passes through numbers unchanged", () => {
  assert.equal(escapeHtml(42), "42");
});

test("html tag escapes interpolated values and returns SafeHtml", () => {
  const out = html`<p>${"<script>alert('xss')</script>"}</p>`;
  assert.equal(out.value, "<p>&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;</p>");
});

test("html tag does not re-escape nested html results", () => {
  const inner = html`<span>${"<b>"}</span>`;
  const outer = html`<p>${inner}</p>`;
  assert.equal(outer.value, "<p><span>&lt;b&gt;</span></p>");
});

test("html tag handles arrays of SafeHtml without escaping them", () => {
  const items = ["<a>", "<b>"].map((v) => html`<li>${v}</li>`);
  const out = html`<ul>${items}</ul>`;
  assert.equal(out.value, "<ul><li>&lt;a&gt;</li><li>&lt;b&gt;</li></ul>");
});

test("rawHtml marks a pre-built string as safe", () => {
  const raw = rawHtml("<strong>bold</strong>");
  const out = html`<p>${raw}</p>`;
  assert.equal(out.value, "<p><strong>bold</strong></p>");
});
