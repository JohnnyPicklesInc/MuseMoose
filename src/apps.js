// Per-app "output contracts". Each app registers a system prompt (describing its
// structured object + rules + a compact example) and a light validator. The
// gateway is generic; only these entries change per app. Add invoiceiguana /
// notenewt here the same way.

// The manifest shape + hard format rules — shared by both the "generate" and
// "edit" system prompts so the two never drift.
const WOMBAT_SHAPE = `MANIFEST SHAPE:
{
  "version": 2,
  "meta": { "name": string, "tagline"?: string, "telephone"?: string, "email"?: string, "address"?: string },
  "theme": { "accent": "#rrggbb", "font": "system"|"serif"|"rounded"|"mono", "mode": "auto"|"light"|"dark" },
  "layout": "landing",              // "landing" = one scrolling page (use this)
  "pages": [ { "name": string, "slug": string, "showInNav": true, "sections": [ SECTION ] } ]
}
SECTION = { "label": string, "background": { "type": "none"|"color"|"gradient", "value"?: "#rrggbb"|"sunset"|"aurora"|"blush"|"mint"|"slate"|"dusk", "text"?: "auto"|"light"|"dark" }, "blocks": [ BLOCK ] }
BLOCK is one of:
  { "type": "heading", "text": string }
  { "type": "text", "text": string }
  { "type": "list", "items": [string] }
  { "type": "rows", "style": "menu"|"hours", "title"?: string, "items": [ { "label": string, "value"?: string, "note"?: string } ] }
  { "type": "button", "label": string, "action": { "type": "tel"|"mailto"|"url"|"directions", "value": string } }
  { "type": "social", "links": [ { "platform": "instagram"|"facebook"|"x"|"tiktok"|"youtube"|"whatsapp"|"website", "url": string } ] }
  { "type": "image", "src": "", "alt": string }
  { "type": "gallery", "layout": "grid"|"scroll", "images": [ { "src": "", "alt": string } ] }
  { "type": "hero", "align": "center", "eyebrow"?: string, "headline": string, "subhead"?: string, "image": { "src": "", "alt": "" }, "buttons": [ { "label": string, "action": { "type": "tel"|"mailto"|"url"|"directions", "value": string } } ] }
  { "type": "columns", "style": "card", "columns": [ { "blocks": [ BLOCK ] } ] }
  { "type": "divider" }

FORMAT RULES (always):
- Output ONLY a single JSON object — a "v2 manifest". No prose, no markdown fences, no comments.
- Always set image/gallery/hero "src" to "" (empty). The user uploads real photos later. Never invent image URLs.`;

const WOMBAT_SYSTEM = `You generate a website for "Website Wombat", a browser-only micro-site builder.

${WOMBAT_SHAPE}

GENERATION RULES:
- Use ONE page unless the request clearly needs several; give it "name":"Home","slug":"".
- Start with a "hero" (headline + eyebrow + call/email buttons), then About, then service/section cards (use "columns" style "card"), then a contact section with tel/mailto buttons.
- Pick an accent hex that fits the business; use real contact details from the request (tel:, mailto:). If a detail is missing, omit that field — do not invent phone numbers or emails.
- Write concise, professional, specific copy. No placeholder lorem ipsum.`;

// Edit mode: given a CURRENT MANIFEST + an EDIT REQUEST, return the whole
// manifest with only the requested change applied.
const WOMBAT_EDIT_SYSTEM = `You EDIT an existing "Website Wombat" site. You are given the CURRENT MANIFEST (a v2 manifest JSON object) and an EDIT REQUEST (a plain-language instruction from the site owner).

${WOMBAT_SHAPE}

EDIT RULES:
- Apply ONLY the change described in the edit request. Make no other changes.
- Preserve every other field, page, section, and block exactly as given — same order, same wording, same slugs, and the same theme values you were not asked to change.
- Return the COMPLETE modified manifest (the whole object), never a diff or just the changed part.
- Keep every existing image/gallery/hero "src" exactly as it is (usually ""). Never invent image URLs.
- If the request is unclear or cannot be applied to this manifest, return the manifest unchanged.`;

const WOMBAT_EXAMPLE = {
  version: 2,
  meta: { name: "Brightleaf Landscaping", tagline: "Lawn & garden care — Austin, TX", telephone: "(512) 555-0100", email: "hello@brightleaf.example" },
  theme: { accent: "#2b8a3e", font: "rounded", mode: "auto" },
  layout: "landing",
  pages: [{
    name: "Home", slug: "", showInNav: true,
    sections: [
      { label: "Home", background: { type: "color", value: "#0f3d24", text: "light" }, blocks: [
        { type: "hero", align: "center", eyebrow: "LAWN & GARDEN CARE · AUSTIN", headline: "A yard you're proud of, without the weekends.", subhead: "Mowing, cleanups, and seasonal planting done right.", image: { src: "", alt: "" }, buttons: [
          { type: "button", label: "Call (512) 555-0100", action: { type: "tel", value: "(512) 555-0100" } },
          { type: "button", label: "Get a free quote", action: { type: "mailto", value: "hello@brightleaf.example" } }
        ].map(function (b) { return { label: b.label, action: b.action }; }) }
      ] },
      { label: "Services", background: { type: "none", text: "auto" }, blocks: [
        { type: "heading", text: "What we do" },
        { type: "columns", style: "card", columns: [
          { blocks: [ { type: "heading", text: "🌱 Mowing & upkeep" }, { type: "text", text: "Weekly or biweekly mowing, edging, and blowdown." } ] },
          { blocks: [ { type: "heading", text: "🍂 Seasonal cleanups" }, { type: "text", text: "Leaf removal, bed refresh, and trimming." } ] },
          { blocks: [ { type: "heading", text: "🪴 Planting" }, { type: "text", text: "Native plants and mulch that thrive in Texas heat." } ] }
        ] }
      ] },
      { label: "Contact", background: { type: "color", value: "#0f3d24", text: "light" }, blocks: [
        { type: "heading", text: "Let's get started" },
        { type: "text", text: "Tell us about your yard and we'll send a free estimate." },
        { type: "button", label: "Call (512) 555-0100", action: { type: "tel", value: "(512) 555-0100" } }
      ] }
    ]
  }]
};

export const APPS = {
  "website-wombat": {
    system: WOMBAT_SYSTEM + "\n\nEXAMPLE (structure to mirror, not copy):\n" + JSON.stringify(WOMBAT_EXAMPLE),
    // Used when the request includes a `manifest` (edit an existing site rather
    // than generate a new one). No example needed — the current manifest is it.
    editSystem: WOMBAT_EDIT_SYSTEM,
    // Light server-side sanity check. The Website Wombat client re-normalizes
    // fully (normalizePages, dropping unknown blocks), so this only needs to
    // confirm we got a plausible manifest object back.
    validate: function (m) {
      if (!m || typeof m !== "object") return "not an object";
      if (!m.meta || typeof m.meta.name !== "string" || !m.meta.name.trim()) return "missing meta.name";
      var hasContent = Array.isArray(m.pages) ? m.pages.some(function (p) { return Array.isArray(p.sections) && p.sections.length; })
        : Array.isArray(m.sections) && m.sections.length;
      if (!hasContent) return "no sections";
      return null; // ok
    }
  }
};
