const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const imageUrl = product => `/api/catalog/${encodeURIComponent(product.id)}/image`;

function catalogSearch(autofocus = false) {
  return `<div class="catalog-search" role="search" aria-label="查找商品">
    <input type="search" id="catalog-query" aria-label="按货号或商品名称搜索" placeholder="按货号或商品名称搜索" ${autofocus ? 'autofocus' : ''}>
  </div>
  <div id="catalog-results"><p class="loading" role="status">正在读取商品资料…</p></div>`;
}

export function renderCatalog() {
  return `<section class="catalog-page">
    <header class="section-heading catalog-heading">
      <div><h1>商品资料库</h1><p>集中维护货号、商品名称和主图，供项目直接选用。</p></div>
      <button type="button" class="button primary" data-action="catalog-new">添加商品</button>
    </header>
    ${catalogSearch()}
  </section>`;
}

function catalogCard(product, picker) {
  const heading = picker ? 'h3' : 'h2';
  const titleId = `catalog-name-${encodeURIComponent(product.id)}`;
  return `<article class="card catalog-card">
    <img class="catalog-card-image" src="${imageUrl(product)}" ${picker ? '' : 'loading="lazy"'} alt="">
    <div class="catalog-card-body">
      <div class="catalog-card-copy">
        <span class="catalog-sku">货号 ${escape(product.sku)}</span>
        <${heading} class="catalog-card-name" id="${titleId}">${escape(product.nameZh)}</${heading}>
        ${product.nameEn ? `<p>${escape(product.nameEn)}</p>` : ''}
      </div>
      <div class="actions">
        <button type="button" class="button secondary button-sm" aria-describedby="${titleId}"
          data-action="${picker ? 'catalog-use' : 'catalog-edit'}" data-id="${escape(product.id)}">${picker ? '选用商品' : '编辑商品'}</button>
      </div>
    </div>
  </article>`;
}

export function catalogCards(products, { picker = false } = {}) {
  if (!products.length) return '<p class="empty" role="status">暂无匹配的商品。</p>';
  return `<div class="catalog-grid">${products.map(product => catalogCard(product, picker)).join('')}</div>`;
}

export function catalogPicker(dialogHead) {
  return `${dialogHead('从资料库选择')}
    <div class="catalog-picker">
      <p>选用后会填入商品货号、中英文名称和主图，并替换本项目中对应的内容。</p>
      ${catalogSearch(true)}
    </div>`;
}

export function catalogForm(dialogHead, product) {
  return `${dialogHead(product ? '编辑商品' : '添加商品')}
    <form id="catalog-form" class="catalog-form">
      <label>货号<input name="sku" maxlength="48" required autofocus value="${escape(product?.sku)}"></label>
      <label>商品名称<input name="nameZh" maxlength="120" required value="${escape(product?.nameZh)}"></label>
      <label>英文名称 <span class="tiny">选填</span><input name="nameEn" maxlength="120" value="${escape(product?.nameEn)}"></label>
      ${product ? `<img class="catalog-form-image" src="${imageUrl(product)}" alt="当前商品主图">` : ''}
      <div>
        <label>${product ? '更换主图' : '商品主图'}
          <input type="file" name="image" accept="image/jpeg,image/png,.jpg,.jpeg,.png" aria-describedby="catalog-image-hint" ${product ? '' : 'required'}>
        </label>
        <p class="tiny catalog-image-hint" id="catalog-image-hint">支持 JPG 和 PNG，单张最多 12 MB。${product ? '留空则保留当前主图。' : ''}</p>
      </div>
      <p id="catalog-form-error" class="catalog-form-error" role="alert" hidden></p>
      <div class="actions">
        <button type="button" class="button flat" data-action="close">取消</button>
        <button type="submit" class="button primary">保存商品</button>
      </div>
    </form>`;
}
