import { avatarDataUrl } from './resident-sprite.js';
// HTML avatar for a resident. Accepts the resident object, or a plain uniform color.
window.pixelAvatar = (agent = {}) => {
  const source = typeof agent === 'string' ? { color: agent, id: agent } : agent;
  return `<img class="px-avatar" src="${avatarDataUrl(source)}" alt="" aria-hidden="true">`;
};
