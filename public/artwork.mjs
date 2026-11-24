import { loadImage, imageData } from './images.mjs';

export async function mountArtwork(canvas, position, config, { photoId, artworkId, customArtwork }) {
  const [photo, artwork] = await Promise.all([loadImage(photoId), loadImage(artworkId)]);
  const maxWidth = 1440;
  const ratio = Math.min(1, maxWidth / photo.naturalWidth);
  canvas.width = Math.round(photo.naturalWidth * ratio);
  canvas.height = Math.round(photo.naturalHeight * ratio);
  const ctx = canvas.getContext('2d');
  const [left, top, right, bottom] = customArtwork
    ? [0, 0, artwork.naturalWidth, artwork.naturalHeight] : config.artworkContentBoundsPx;
  const sourceWidth = right - left;
  const sourceHeight = bottom - top;
  const area = config.editableArea;

  function draw() {
    const width = canvas.width * position.widthRatio;
    const height = width * sourceHeight / sourceWidth;
    ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width * position.centerX, canvas.height * position.centerY);
    ctx.rotate(position.rotationDegrees * Math.PI / 180);
    ctx.drawImage(artwork, left, top, sourceWidth, sourceHeight, -width / 2, -height / 2, width, height);
    ctx.restore();
  }

  const numbers = canvas.closest('.artwork-panel').querySelectorAll('input[data-position]');
  const sync = () => {
    for (const input of numbers) {
      input.value = position[input.dataset.position];
      input.nextElementSibling.value = display(input.dataset.position, position[input.dataset.position]);
    }
    draw();
  };
  for (const input of numbers) {
    input.addEventListener('input', () => {
      position[input.dataset.position] = Number(input.value);
      sync();
    });
  }
  let pointer = null;
  const move = event => {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    position.centerX = Number(Math.max(area.x, Math.min(area.x + area.width, x)).toFixed(3));
    position.centerY = Number(Math.max(area.y, Math.min(area.y + area.height, y)).toFixed(3));
    sync();
  };
  canvas.addEventListener('pointerdown', event => {
    pointer = event.pointerId;
    canvas.setPointerCapture(pointer);
    move(event);
  });
  canvas.addEventListener('pointermove', event => { if (pointer === event.pointerId) move(event); });
  const release = event => { if (pointer === event.pointerId) pointer = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  sync();
  return { draw: sync, exportImage: () => imageData(canvas) };
}

export function display(key, value) {
  return key === 'rotationDegrees' ? `${value}°` : `${Math.round(value * 100)}%`;
}
