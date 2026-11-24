const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });
const projectUrl = project => `/?project=${encodeURIComponent(project.id)}#${project.isDemo ? 'overview' : 'inquiry'}`;
const folderIcon = '<span class="project-folder" aria-hidden="true"></span>';

function projectCard(project) {
  const name = escape(project.name);
  return `<a class="card project-card" href="${projectUrl(project)}">
    <span class="project-card-markers" aria-hidden="true">
      ${folderIcon}<span class="project-card-arrow">↗</span>
    </span>
    <div class="project-card-copy">
      <h3 title="${name}">${name}</h3>
      <p>${project.customer ? `${escape(project.customer)} · ` : ''}<time datetime="${escape(project.createdAt)}">${dateFormat.format(new Date(project.createdAt))} 创建</time></p>
    </div>
  </a>`;
}

function exampleCard(project) {
  const name = escape(project.name);
  const isLemonExample = project.id === 'demo-001';
  const category = isLemonExample ? '酒店早餐' : project.customer;
  const preview = isLemonExample
    ? '<img class="project-example-preview" src="/api/assets/lifestyle-kit?project=demo-001" width="160" height="126" alt="">'
    : `<span class="project-example-preview project-example-preview-empty" aria-hidden="true">${folderIcon}</span>`;
  return `<a class="card project-example-card" href="${projectUrl(project)}" aria-label="打开示例 ${name}">
    ${preview}
    <div class="project-example-copy">
      ${category ? `<p>${escape(category)}</p>` : ''}
      <h3>${name}</h3>
      <span class="project-example-action">打开示例 <span aria-hidden="true">→</span></span>
    </div>
  </a>`;
}

export function renderProjects(projects) {
  const own = projects.filter(project => !project.isDemo);
  const examples = projects.filter(project => project.isDemo);
  return `<div class="projects-page">
    <header class="projects-heading">
      <div><h1>项目工作台</h1><p>管理客户询盘、商品设计与出口提案。</p></div>
      <button class="button primary project-new-button" type="button" data-action="project-new">
        <span aria-hidden="true">+</span>新建项目
      </button>
    </header>
    <section class="project-collection" aria-labelledby="my-projects-title">
      <h2 id="my-projects-title">我的项目</h2>
      <div class="project-grid">
        ${own.length ? own.map(projectCard).join('') : `<div class="card project-empty">
          ${folderIcon}
          <div><strong>还没有项目</strong><p>新建项目后，可粘贴或上传客户询盘。</p></div>
        </div>`}
      </div>
    </section>
    ${examples.length ? `<section class="project-example" aria-labelledby="project-example-title">
      <h2 id="project-example-title">示例项目</h2>
      <div class="project-grid">${examples.map(exampleCard).join('')}</div>
    </section>` : ''}
  </div>`;
}

export function projectFormMarkup(dialogHead) {
  return `${dialogHead('新建项目')}
    <form id="project-new-form" class="project-create">
      <label class="project-create-field">项目名称
        <input name="name" maxlength="80" required autofocus placeholder="例如：酒店早餐杯碟采购">
      </label>
      <label class="project-create-field">客户名称 <span>选填</span>
        <input name="customer" maxlength="80" placeholder="例如：客户公司名称">
      </label>
      <fieldset class="project-template">
        <legend>起始内容</legend>
        <label>
          <input type="radio" name="template" value="blank" checked>
          <span><strong>空白项目</strong><small>从自己的客户询盘开始。</small></span>
        </label>
        <label>
          <input type="radio" name="template" value="lemon">
          <span><strong>柠檬蓝花模板</strong><small>沿用 146 杯碟资料及印花、包装素材。</small></span>
        </label>
      </fieldset>
      <p id="project-new-error" class="project-create-error" role="alert" hidden></p>
      <div class="actions">
        <button type="button" class="button flat" data-action="close">取消</button>
        <button type="submit" class="button primary">新建项目</button>
      </div>
    </form>`;
}
