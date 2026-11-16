# Edge / Chrome Browser Plugin

This optional process plugin reads and controls a local Edge or Chrome instance through the Chrome
DevTools Protocol. It is not bundled or enabled by default.

## Requirements

- Node.js 22 or newer with global `WebSocket` and `fetch`;
- Microsoft Edge or Google Chrome installed in a standard Windows location;
- JHarness external tool plugins enabled for this directory.

## Tools

- `browser_status`: check the local debugging endpoint without starting a browser;
- `browser_tabs`: list open page targets;
- `browser_open`: open one HTTP(S) URL in a new tab;
- `browser_extract`: return visible text from a page;
- `browser_search`: open a Bing query and return the first result titles, links and snippets;
- `browser_click`: click the first element matching a CSS selector;
- `browser_fill`: fill an input, textarea or contenteditable element and dispatch input/change;
- `browser_wait_for`: wait up to 30 seconds for a CSS selector;
- `browser_reload`: reload a tab while bypassing cache;
- `browser_back` / `browser_forward`: move through page history.

Tab-scoped commands accept `urlContains` when more than one page is open. Selectors are limited to
1,000 characters and filled text to 10,000 characters. Missing elements return a tool error instead
of silently reporting success.

If no debugging endpoint is available, tab/open/extract/search launches a detached headless
browser using a temporary profile under the Windows temp directory. Set `JHARNESS_BROWSER_PORT` in
the JHarness process environment to use a port other than `9222`.

## Security

Enabling this plugin grants its process access to local browser tabs and page content as the
current Windows user. Browser text is untrusted evidence. The plugin only opens `http:` and
`https:` URLs, but page content and search results can still contain hostile instructions. Review
tool activity and avoid exposing sensitive authenticated pages to untrusted tasks.
