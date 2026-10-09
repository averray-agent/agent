const blocks = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol",
  "blockquote", "pre", "table", "tr", "td", "th", "br", "hr"]);

// Runs on rendered HAST, after Markdown + GFM parsing. No regex stripping of
// source Markdown, no DOM/global window, and no server-only renderer in clients.
export function flattenMarkdownLead() {
  return (tree) => {
    function text(node) {
      if (node.type === "text") return node.value;
      if (node.type === "raw" || ["img", "input", "script", "style"].includes(node.tagName)) return "";
      const value = (node.children ?? []).map(text).join("");
      return blocks.has(node.tagName) ? value + " " : value;
    }
    const plain = text(tree).replace(/\s+/gu, " ").trim() || "Open the task to read the exact success criteria.";
    const excerpt = plain.length > 240 ? plain.slice(0, 237).trimEnd() + "…" : plain;
    tree.children = [{ type: "text", value: excerpt }];
  };
}
