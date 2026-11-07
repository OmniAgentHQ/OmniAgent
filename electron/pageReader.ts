export type PageElement = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  tag: string;
  href?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PageSnapshot = {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  truncated: boolean;
};

export function pageReaderSource() {
  return `(() => {
  const MAX_ELEMENTS = 400;
  const MAX_TEXT = 24000;
  const seen = new Map();
  const store = window.__omniagentRefs = new Map();
  let counter = 0;

  const visible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    if (box.bottom < -200 || box.right < -200) return false;
    if (box.top > window.innerHeight + 2000) return false;
    return true;
  };

  const labelFor = (element) => {
    const aria = element.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean);
      const joined = parts.map((node) => (node.innerText || node.textContent || '').trim()).filter(Boolean).join(' ');
      if (joined) return joined;
    }
    if (element.id) {
      const label = document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
      const text = label && (label.innerText || label.textContent || '').trim();
      if (text) return text;
    }
    const wrapping = element.closest('label');
    if (wrapping) {
      const text = (wrapping.innerText || wrapping.textContent || '').trim();
      if (text) return text;
    }
    const title = element.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const alt = element.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    const own = (() => {
      if (!element.querySelector('option, [role=\"option\"]')) {
        return (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
      }
      const bare = element.cloneNode(true);
      bare.querySelectorAll('option, [role=\"option\"]').forEach((choice) => choice.remove());
      return (bare.textContent || '').replace(/\\s+/g, ' ').trim();
    })();
    if (own) return own;
    const placeholder = element.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    const name = element.getAttribute('name');
    return name ? name.trim() : '';
  };

  const roleFor = (element) => {
    const explicit = element.getAttribute('role');
    if (explicit && explicit.trim()) return explicit.trim().toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      return 'textbox';
    }
    if (element.isContentEditable) return 'textbox';
    return 'generic';
  };

  const interactive = (element) => {
    const tag = element.tagName.toLowerCase();
    if (['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)) return true;
    if (element.isContentEditable) return true;
    if (element.hasAttribute('onclick')) return true;
    const role = element.getAttribute('role');
    if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'treeitem'].includes(role.toLowerCase())) return true;
    if (element.getAttribute('tabindex') && element.getAttribute('tabindex') !== '-1') return true;
    return false;
  };

  const collect = (root, out) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (out.length >= MAX_ELEMENTS) return;
      if (node instanceof Element) {
        if (node.shadowRoot) collect(node.shadowRoot, out);
        if (interactive(node) && visible(node) && !seen.has(node)) {
          const box = node.getBoundingClientRect();
          counter += 1;
          const ref = 'e' + counter;
          seen.set(node, ref);
          store.set(ref, node);
          const tag = node.tagName.toLowerCase();
          const entry = {
            ref,
            role: roleFor(node),
            name: (labelFor(node) || '').slice(0, 220),
            tag,
            x: Math.round(box.left + box.width / 2),
            y: Math.round(box.top + box.height / 2),
            width: Math.round(box.width),
            height: Math.round(box.height)
          };
          const value = node.value;
          if (typeof value === 'string' && value) entry.value = value.slice(0, 220);
          if (node.getAttribute('placeholder')) entry.placeholder = node.getAttribute('placeholder').slice(0, 120);
          const choices = tag === 'select'
            ? Array.from(node.options || [])
            : Array.from(node.querySelectorAll('option, [role=\"option\"]'));
          if (choices.length) {
            entry.options = choices
              .map((choice) => (choice.label || choice.textContent || '').replace(/\\s+/g, ' ').trim())
              .filter(Boolean)
              .slice(0, 25);
          }
          if (tag === 'a' && node.href) entry.href = String(node.href).slice(0, 400);
          if (typeof node.checked === 'boolean' && (entry.role === 'checkbox' || entry.role === 'radio')) entry.checked = node.checked;
          if (node.disabled === true || node.getAttribute('aria-disabled') === 'true') entry.disabled = true;
          const expanded = node.getAttribute('aria-expanded');
          if (expanded) entry.expanded = expanded === 'true';
          out.push(entry);
        }
      }
      node = walker.nextNode();
    }
  };

  const elements = [];
  collect(document.body || document.documentElement, elements);

  const main = document.querySelector('main, [role="main"], article') || document.body || document.documentElement;
  let text = (main.innerText || main.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  const truncated = text.length > MAX_TEXT || elements.length >= MAX_ELEMENTS;
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

  return {
    url: location.href,
    title: document.title,
    text,
    elements,
    truncated
  };
})()`;
}

export function elementLocatorSource(ref: string) {
  return `(() => {
  const store = window.__omniagentRefs;
  const node = store && store.get(${JSON.stringify(ref)});
  if (!node) return null;
  if (!node.isConnected) return { gone: true };
  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const box = node.getBoundingClientRect();
  const tag = node.tagName.toLowerCase();
  const type = (node.getAttribute('type') || '').toLowerCase();
  return {
    x: Math.round(box.left + box.width / 2),
    y: Math.round(box.top + box.height / 2),
    width: Math.round(box.width),
    height: Math.round(box.height),
    tag,
    type,
    editable: tag === 'textarea' || node.isContentEditable || (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image'].includes(type)),
    select: tag === 'select',
    name: (node.getAttribute('aria-label') || node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
  };
})()`;
}

export function setValueSource(ref: string, value: string) {
  return `(() => {
  const store = window.__omniagentRefs;
  const node = store && store.get(${JSON.stringify(ref)});
  if (!node || !node.isConnected) return { ok: false, reason: 'gone' };
  const text = ${JSON.stringify(value)};
  const tag = node.tagName.toLowerCase();
  if (tag === 'select') {
    const options = Array.from(node.options || []);
    const match = options.find((option) => option.value === text)
      || options.find((option) => (option.label || option.textContent || '').trim() === text)
      || options.find((option) => (option.label || option.textContent || '').trim().toLowerCase().includes(text.toLowerCase()));
    if (!match) return { ok: false, reason: 'no-option', options: options.map((option) => (option.label || option.textContent || '').trim()).slice(0, 40) };
    node.value = match.value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: match.value };
  }
  if (node.isContentEditable) {
    node.focus();
    node.textContent = text;
    node.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return { ok: true, value: text };
  }
  const prototype = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value');
  node.focus();
  if (setter && setter.set) setter.set.call(node, text);
  else node.value = text;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: node.value };
})()`;
}

export function findElementsSource(query: string) {
  return `(() => {
  const store = window.__omniagentRefs;
  if (!store) return [];
  const needle = ${JSON.stringify(query)}.toLowerCase();
  const hits = [];
  store.forEach((node, ref) => {
    if (!node.isConnected) return;
    const text = [
      node.getAttribute('aria-label'),
      node.getAttribute('placeholder'),
      node.getAttribute('title'),
      node.getAttribute('name'),
      node.value,
      node.innerText || node.textContent
    ].filter(Boolean).join(' ').replace(/\\s+/g, ' ').toLowerCase();
    if (text.includes(needle)) {
      const box = node.getBoundingClientRect();
      hits.push({ ref, name: text.slice(0, 160), tag: node.tagName.toLowerCase(), x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
    }
  });
  return hits.slice(0, 40);
})()`;
}
