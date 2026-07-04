export type BrowserTab = { id: string; url: string; title: string };

// A plain iframe per tab. All open tabs stay mounted for their whole
// lifetime — only the active one is display:block — so switching tabs
// preserves each one's session/history, same as the previous native
// child-webview approach, but as an ordinary DOM element: it paints in
// normal document flow/z-order (so it no longer covers modals) and needs no
// Rust-side positioning code at all.
//
// Known trade-off (accepted): sites sending X-Frame-Options: DENY or a
// restrictive frame-ancestors CSP (Google, most banks, many login-gated
// apps) will refuse to load inside this iframe. There is no workaround
// short of a full embedded browser engine (CEF), which was ruled out as
// impractical for this app.
export default function BrowserTabView({ tab, isActive }: { tab: BrowserTab; isActive: boolean }) {
  return (
    <iframe
      src={tab.url}
      title={tab.title || tab.url}
      // allow-same-origin + allow-scripts covers normal site behavior
      // (including most OAuth popups via allow-popups); allow-top-navigation
      // is deliberately omitted so an embedded page can't navigate the whole
      // MAHI window away from under the user.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"
      style={{ width: "100%", height: "100%", border: "none", display: isActive ? "block" : "none", background: "#fff" }}
    />
  );
}
