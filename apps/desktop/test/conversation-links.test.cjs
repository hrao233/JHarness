const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let conversationLinkUrl;
let navigationAddress;

before(async () => {
  const { build } = await import('vite');
  const [convBundle] = await build({
    configFile: false,
    logLevel: 'error',
    external: ['react', 'lucide-react', 'react-markdown', 'remark-gfm'],
    build: {
      write: false,
      rollupOptions: { external: ['react', 'react/jsx-runtime', 'lucide-react', 'react-markdown', 'remark-gfm'] },
      lib: {
        entry: path.resolve(__dirname, '../../ui/src/Conversation.jsx'),
        formats: ['cjs']
      }
    }
  });
  const convMod = { exports: {} };
  new Function('exports', 'module', 'require', convBundle.output[0].code)(
    convMod.exports, convMod, () => ({})
  );
  conversationLinkUrl = convMod.exports.conversationLinkUrl;

  const [browserBundle] = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      rollupOptions: { external: ['react', 'react/jsx-runtime', 'lucide-react'] },
      lib: {
        entry: path.resolve(__dirname, '../../ui/src/BrowserPanel.jsx'),
        formats: ['cjs']
      }
    }
  });
  const browserMod = { exports: {} };
  new Function('exports', 'module', 'require', browserBundle.output[0].code)(
    browserMod.exports, browserMod, () => ({})
  );
  navigationAddress = browserMod.exports.navigationAddress;
});

test('validates clickable HTTP(S) conversation links and rejects unsafe or local-file targets', () => {
  assert.equal(
    conversationLinkUrl('https://arxiv.org/abs/2402.14034'),
    'https://arxiv.org/abs/2402.14034'
  );
  assert.equal(
    conversationLinkUrl('http://127.0.0.1:8080/papers?q=angle-core#sec-1'),
    'http://127.0.0.1:8080/papers?q=angle-core#sec-1'
  );
  assert.equal(
    conversationLinkUrl('//arxiv.org/pdf/2402.14034.pdf'),
    'https://arxiv.org/pdf/2402.14034.pdf'
  );
  assert.equal(conversationLinkUrl('javascript:alert(1)'), '');
  assert.equal(conversationLinkUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(conversationLinkUrl('file:///C:/Windows/system.ini'), '');
  assert.equal(conversationLinkUrl('https://user:secret@example.com/private'), '');
  assert.equal(conversationLinkUrl('README.md'), '');
  assert.equal(conversationLinkUrl('apps/ui/src/main.jsx'), '');
  assert.equal(conversationLinkUrl('#section'), '');
  assert.equal(
    navigationAddress(conversationLinkUrl('https://arxiv.org/abs/2402.14034')),
    'https://arxiv.org/abs/2402.14034'
  );
});
