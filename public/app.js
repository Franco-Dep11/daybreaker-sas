const app = document.querySelector('#app');
const toastBox = document.querySelector('#toast');
const cartStorageKey = 'daybreaker-cart-v1';
const adminSessionMaxAgeMs = 60_000;
const statusText = {
  received: 'Pedido recibido',
  freight_quoted: 'Flete cotizado',
  awaiting_payment: 'Total aceptado · pago pendiente',
  payment_confirmed: 'Pago confirmado',
  preparing: 'En preparación',
  dispatched: 'Despachado',
  delivered: 'Entregado',
  canceled: 'Cancelado',
  pending: 'Pendiente',
  responded: 'Respondida',
  closed: 'Cerrada',
  pending_verification: 'A verificar',
  confirmed: 'Confirmado',
  failed: 'Fallido',
};

const state = {
  config: { contactEmail: '', whatsappPhone: '', transferEnabled: false, mercadopagoEnabled: false, adminEnabled: false, readOnlyPreview: false },
  products: [],
  cart: loadCart(),
  quoteDraft: [],
  admin: { authenticated: false, authStatus: 'unknown', validatedAt: 0, sessionRequest: null, routeActive: false, tab: 'products', productEdit: null, orders: [], quotes: [], products: [], categories: [], loaded: {}, errors: {}, requests: {}, productCategory: '', productVisibility: '', filter: {} },
  toastTimer: 0,
  routeVersion: 0,
};

function loadCart() {
  try {
    const value = JSON.parse(localStorage.getItem(cartStorageKey) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function saveCart() {
  localStorage.setItem(cartStorageKey, JSON.stringify(state.cart));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function money(cents) {
  if (cents === null || cents === undefined) return 'A cotizar';
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 2 }).format(cents / 100);
}

function moneyInput(cents) {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'No se pudo completar la solicitud.'); error.status = response.status;
    if (response.status === 401 && path.startsWith('/api/admin/') && path !== '/api/admin/login') {
      clearAdminPrivateData();
      if (state.admin.routeActive) render();
    }
    throw error;
  }
  return data;
}

function showToast(message) {
  toastBox.textContent = message;
  toastBox.classList.add('is-visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toastBox.classList.remove('is-visible'), 3600);
}

function setRoute(route) {
  const paths = {
    inicio: '/', 'quienes-somos': '/quienes-somos', catalogo: '/catalogo',
    presupuestos: '/presupuestos-mayoristas', carrito: '/carrito', contacto: '/contacto',
  };
  const target = route === 'admin' ? '/#admin' : (paths[route] || '/');
  window.history.pushState({}, '', target);
  render();
}

function navActive(route) {
  document.querySelectorAll('[data-route]').forEach(link => {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function shell(content, route = '') {
  navActive(route);
  const previewNotice = state.config.readOnlyPreview
    ? '<div class="deployment-notice notice" role="status"><div><strong>Vista de publicación.</strong> Esta versión permite recorrer la web. Los pedidos, presupuestos y cambios del panel se habilitarán al conectar una base de datos persistente.</div></div>'
    : '';
  return `${previewNotice}${content}`;
}

function heroPage() {
  const count = Object.keys(state.cart).reduce((sum, id) => sum + (Number(state.cart[id]) || 0), 0);
  return shell(`
    <section class="hero">
      <div class="hero-inner">
        <div class="hero-copy">
          <span class="eyebrow">DAYBREAKER SAS · Argentina</span>
          <h1>Comercio claro.<br><em>Operación confiable.</em></h1>
          <p class="hero-lede">Catálogo minorista y atención mayorista, con precios visibles y envío cotizado antes de confirmar el pago.</p>
          <div class="hero-actions">
            <a class="button button-accent" href="/catalogo">Explorar catálogo <span aria-hidden="true">→</span></a>
            <a class="button button-outline" href="/presupuestos-mayoristas">Solicitar presupuesto</a>
          </div>
          <div class="hero-footnote"><span>Compra sin cuenta</span><span>Envíos a toda Argentina</span><span>Flete a cotizar</span></div>
        </div>
      </div>
    </section>
    <div class="feature-strip">
      <div class="feature-cell"><strong>Precio minorista visible</strong><span>El precio final de productos se muestra en pesos argentinos.</span></div>
      <div class="feature-cell"><strong>Flete informado antes del pago</strong><span>Confirmás el total una vez que DAYBREAKER cotiza el transporte.</span></div>
      <div class="feature-cell"><strong>Atención mayorista</strong><span>Enviá productos y cantidades; la respuesta es personalizada.</span></div>
    </div>
    <section class="section">
      <div class="section-shell split-layout">
        <div>
          <span class="eyebrow">Una forma simple de operar</span>
          <h2>Elegí cómo querés avanzar.</h2>
          <p>Comprá unidades con precio minorista o reuní varios productos en una consulta mayorista. En compras minoristas, el costo de envío se cotiza según destino y volumen antes de habilitar el pago.</p>
          <div class="hero-actions">
            <a class="button button-dark" href="/catalogo">Ver catálogo</a>
            <a class="button button-outline" href="/carrito">Carrito${count ? ` · ${count}` : ''} y seguimiento</a>
          </div>
        </div>
        <div class="industrial-card" aria-label="DAYBREAKER, atención comercial en toda Argentina">
          <span class="industrial-card-label">Atención comercial</span>
          <h3>Minorista y mayorista, en un mismo lugar.</h3>
          <span class="industrial-card-number">DB / AR</span>
        </div>
      </div>
    </section>
    <section class="section section-compact home-how">
      <div class="section-shell">
        <div class="section-heading"><span class="eyebrow">Cómo funciona</span><h2>Un proceso simple y transparente.</h2></div>
        <div class="process-grid">
          <article class="process-item"><span>01 / ELEGÍ</span><h3>Armá tu pedido</h3><p>Sumá productos al carrito sin crear una cuenta o consultá cantidades para una compra mayorista.</p></article>
          <article class="process-item"><span>02 / CONFIRMÁ</span><h3>Recibí el costo de envío</h3><p>DAYBREAKER cotiza el flete y te comunica el total. Ningún pedido se cobra antes de tu aceptación.</p></article>
          <article class="process-item"><span>03 / SEGUÍ</span><h3>Pagá y consultá el estado</h3><p>Elegí un medio de pago habilitado y usá tu enlace privado para ver el avance del pedido.</p></article>
        </div>
      </div>
    </section>`, 'inicio');
}

function aboutPage() {
  return shell(`
    <section class="section"><div class="section-shell">
      <div class="section-heading"><span class="eyebrow">Quiénes somos</span><h1>DAYBREAKER SAS</h1>
        <p>Un espacio de atención comercial para compras minoristas y consultas mayoristas en Argentina.</p>
      </div>
      <div class="split-layout">
        <div><h2>Información comercial directa.</h2><p>El sitio reúne catálogo, pedidos y solicitudes de presupuesto en una sola experiencia. Los precios minoristas se publican en pesos argentinos; las condiciones mayoristas se conversan caso por caso.</p><p>Los datos institucionales, la historia de la empresa y cualquier otra información corporativa se incorporarán cuando DAYBREAKER autorice el contenido definitivo.</p><a class="button button-dark" href="/contacto">Contactar al equipo</a></div>
        <div class="industrial-card"><span class="industrial-card-label">Servicio comercial</span><h3>Atención para clientes de todo el país.</h3><span class="industrial-card-number">DAYBREAKER SAS</span></div>
      </div>
    </div></section>`, 'quienes-somos');
}

function availabilityBadge(value) {
  if (value === 'available') return '<span class="badge">Disponible</span>';
  if (value === 'on_request') return '<span class="badge badge-warn">A pedido</span>';
  return '<span class="badge badge-muted">Agotado</span>';
}

function productCard(product) {
  const image = product.imageUrl
    ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy">`
    : '<span class="product-image-mark">DAYBREAKER / PRODUCTO</span>';
  const canBuy = product.availability === 'available';
  return `<article class="product-card">
    <a class="product-image" href="/productos/${encodeURIComponent(product.slug)}" aria-label="Ver ${escapeHtml(product.name)}">
      ${image}${availabilityBadge(product.availability)}
    </a>
    <div class="product-content">
      <h3><a href="/productos/${encodeURIComponent(product.slug)}">${escapeHtml(product.name)}</a></h3>
      <p>${escapeHtml(product.shortDescription || 'Consultá las especificaciones y disponibilidad de este producto.')}</p>
      <span class="product-price-label">Precio minorista</span><strong class="product-price">${money(product.retailPriceCents)}</strong>
      <div class="product-actions">
        ${canBuy ? `<button class="button button-dark button-block" type="button" data-action="add-cart" data-product-id="${escapeHtml(product.id)}">Agregar al carrito</button>` : `<button class="button button-outline button-block" type="button" data-action="quote-product" data-product-id="${escapeHtml(product.id)}">Consultar disponibilidad</button>`}
        <a class="button button-outline button-block" href="/productos/${encodeURIComponent(product.slug)}">Ver ficha <span aria-hidden="true">↗</span></a>
        <button class="text-button" type="button" data-action="quote-product" data-product-id="${escapeHtml(product.id)}">Solicitar cotización mayorista</button>
      </div>
    </div>
  </article>`;
}

function catalogPage() {
  const products = state.products;
  const body = products.length
    ? `<div class="catalog-toolbar"><div><span class="eyebrow">Compra minorista</span><h2>Productos</h2></div><label class="field search-field"><span class="field-label">Buscar en el catálogo</span><input id="catalog-search" type="search" placeholder="Nombre o descripción" autocomplete="off"></label></div>
       <div class="product-grid" id="product-grid">${products.map(productCard).join('')}</div>
       <div class="empty-state" id="catalog-no-results" hidden><h3>No encontramos coincidencias.</h3><p>Probá con otro término o solicitá un presupuesto mayorista.</p><a class="button button-outline" href="/presupuestos-mayoristas">Solicitar presupuesto</a></div>`
    : `<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">＋</span><h3>El catálogo se está preparando.</h3><p>Cuando DAYBREAKER cargue los productos, precios y materiales autorizados, aparecerán aquí con sus fichas y opciones de compra. No se publican importes estimados.</p></div>`;
  return shell(`<section class="section"><div class="section-shell"><div class="section-heading"><span class="eyebrow">Catálogo</span><h1>Productos y soluciones</h1><p>Precios minoristas en pesos argentinos. El costo de transporte se cotiza por separado según el destino.</p></div>${body}</div></section>`, 'catalogo');
}

function productPageMarkup(product) {
  const image = product.imageUrl
    ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}">`
    : '<span class="product-image-mark">DAYBREAKER / PRODUCTO</span>';
  const canBuy = product.availability === 'available';
  const gallery = (product.images || []).length > 1 ? `<div class="product-gallery">${product.images.map(image => `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText || product.name)}" loading="lazy">`).join('')}</div>` : '';
  return shell(`<section class="section"><div class="section-shell">
    <p class="kicker"><a href="/catalogo">Catálogo</a> / Ficha de producto</p>
    <div class="split-layout product-detail-layout">
      <div><div class="product-image product-detail-image">${image}${availabilityBadge(product.availability)}</div>${gallery}</div>
      <div><span class="eyebrow">Ficha de producto</span><h1 class="product-title">${escapeHtml(product.name)}</h1>
        ${availabilityBadge(product.availability)}<p class="product-description">${escapeHtml(product.shortDescription || 'La descripción comercial se completará con los datos aprobados por DAYBREAKER.')}</p>
        <span class="product-price-label">Precio minorista</span><strong class="product-price product-price-detail">${money(product.retailPriceCents)}</strong>
        ${product.specifications ? `<div class="panel-card specification-panel"><h2>Especificaciones</h2><p>${escapeHtml(product.specifications)}</p></div>` : ''}
        <p class="product-shipping-note">El transporte se cotiza según domicilio, volumen y cantidad. El pago queda habilitado después de aceptar el total final.</p>
        <div class="hero-actions">${canBuy ? `<button class="button button-accent" type="button" data-action="add-cart" data-product-id="${escapeHtml(product.id)}">Agregar al carrito</button>` : '<span class="badge badge-warn">Consultá disponibilidad</span>'}<button class="button button-outline" type="button" data-action="quote-product" data-product-id="${escapeHtml(product.id)}">Cotizar al por mayor</button></div>
        ${product.technicalPdfUrl ? `<p><a href="${escapeHtml(product.technicalPdfUrl)}" target="_blank" rel="noopener noreferrer">Abrir ficha técnica PDF ↗</a></p>` : ''}
      </div>
    </div></div></section>`, 'catalogo');
}

function quoteRow(index, selected = {}) {
  const options = state.products.map(product => `<option value="${escapeHtml(product.id)}" ${selected.productId === product.id ? 'selected' : ''}>${escapeHtml(product.name)}</option>`).join('');
  const defaultCustom = state.products.length ? '' : 'custom';
  return `<div class="quote-item-row" data-quote-row="${index}">
    <div class="field"><label for="quote-product-${index}">Producto</label><select id="quote-product-${index}" name="productId" data-quote-select required>
      ${state.products.length ? '<option value="">Elegí del catálogo</option>' : '<option value="custom">Indicar producto</option>'}
      ${options}<option value="custom" ${(selected.productId === 'custom' || defaultCustom === 'custom') ? 'selected' : ''}>Otro producto / indicar</option>
    </select><input name="productName" aria-label="Producto solicitado" placeholder="Nombre o descripción del producto" value="${escapeHtml(selected.productName || '')}" ${selected.productId && selected.productId !== 'custom' ? 'hidden' : ''} ${selected.productId === 'custom' || !state.products.length ? 'required' : ''}></div>
    <div class="field"><label for="quote-qty-${index}">Cantidad</label><input id="quote-qty-${index}" name="quantity" type="number" min="1" max="9999" value="${escapeHtml(selected.quantity || 1)}" required></div>
    <button class="remove-row" type="button" data-action="remove-quote-row" aria-label="Quitar producto">Quitar</button>
  </div>`;
}

function quotePage() {
  if (!state.quoteDraft.length) state.quoteDraft = [{ productId: state.products.length ? '' : 'custom', productName: '', quantity: 1 }];
  return shell(`<section class="section"><div class="section-shell"><div class="section-heading"><span class="eyebrow">Presupuestos mayoristas</span><h1>Contanos qué necesitás.</h1><p>Enviá productos, cantidades y destino. DAYBREAKER revisará la solicitud y te responderá de forma manual por email o WhatsApp.</p></div>
    <div class="quote-layout"><form class="form-card" id="quote-form"><h2>Solicitar presupuesto</h2><p class="form-intro">No necesitás crear una cuenta. Los campos marcados son necesarios para responderte.</p>
      <div class="form-grid">
        <div class="field"><label for="quote-company">Razón social</label><input id="quote-company" name="companyName" maxlength="180" placeholder="Opcional si completás el contacto"></div>
        <div class="field"><label for="quote-contact">Nombre de contacto</label><input id="quote-contact" name="contactName" maxlength="120" placeholder="Nombre y apellido"></div>
        <div class="field"><label for="quote-cuit">CUIT</label><input id="quote-cuit" name="cuit" maxlength="16" placeholder="Opcional"></div>
        <div class="field"><label for="quote-phone">Teléfono</label><input id="quote-phone" name="phone" autocomplete="tel" maxlength="80" required></div>
        <div class="field"><label for="quote-email">Email</label><input id="quote-email" name="email" type="email" autocomplete="email" maxlength="254" required></div>
        <div class="field"><label for="quote-destination">Destino</label><input id="quote-destination" name="destination" maxlength="240" placeholder="Localidad, provincia y código postal" required></div>
        <div class="field field-full"><span class="field-label">Productos y cantidades</span><div class="quote-items" id="quote-items">${state.quoteDraft.map((item, index) => quoteRow(index, item)).join('')}</div><button class="button button-outline button-small" type="button" data-action="add-quote-row">＋ Agregar producto</button></div>
        <div class="field field-full"><label for="quote-notes">Observaciones</label><textarea id="quote-notes" name="notes" maxlength="1200" placeholder="Contanos detalles que nos ayuden a preparar la respuesta."></textarea></div>
      </div>
      <div id="quote-error" class="form-error" role="alert" hidden></div>
      <div class="form-actions"><button class="button button-accent" type="submit">Enviar solicitud <span aria-hidden="true">→</span></button><span class="field-help">Tu solicitud se guarda para que el equipo pueda gestionarla.</span></div>
      <div id="quote-result" class="quote-result" aria-live="polite"></div>
    </form>
    <aside class="quote-side"><span class="eyebrow">Atención personalizada</span><h3>Presupuesto a medida.</h3><p>La cotización mayorista se gestiona por separado de los pedidos minoristas. El precio mayorista no se calcula ni se publica automáticamente.</p><ul><li>Identificación y fecha de solicitud</li><li>Productos y cantidades seleccionados</li><li>Respuesta manual por email o WhatsApp</li><li>Sin compromiso de compra</li></ul></aside></div></div></section>`, 'presupuestos');
}

function cartPage() {
  const entries = Object.entries(state.cart).filter(([id, qty]) => Number(qty) > 0).map(([id, qty]) => ({ product: state.products.find(item => item.id === id), quantity: Number(qty) })).filter(row => row.product);
  const total = entries.reduce((sum, row) => sum + row.product.retailPriceCents * row.quantity, 0);
  const lostItems = Object.keys(state.cart).some(id => !state.products.some(product => product.id === id));
  const staleRows = Object.keys(state.cart).filter(id => !state.products.some(product => product.id === id)).map(id => `<div class="cart-line"><div><h3>Producto retirado del catálogo</h3><p>Quitalo para continuar con el pedido.</p></div><strong class="badge badge-muted">No disponible</strong><button class="remove-row" type="button" data-action="remove-cart" data-product-id="${escapeHtml(id)}">Quitar</button></div>`).join('');
  const unavailableItems = entries.some(row => row.product.availability !== 'available');
  const itemsMarkup = entries.length ? entries.map(row => `<div class="cart-line">
    <div><h3>${escapeHtml(row.product.name)}</h3><p>${money(row.product.retailPriceCents)} por unidad · ${escapeHtml(row.product.availability === 'available' ? 'Disponible' : 'No disponible para compra')}</p></div>
    <label class="field"><span class="field-label">Unidades</span><input type="number" min="1" max="9999" value="${row.quantity}" data-cart-qty="${escapeHtml(row.product.id)}" aria-label="Cantidad de ${escapeHtml(row.product.name)}"></label>
    <strong class="cart-line-total">${money(row.product.retailPriceCents * row.quantity)}</strong>
    <button class="remove-row" type="button" data-action="remove-cart" data-product-id="${escapeHtml(row.product.id)}">Quitar</button>
  </div>`).join('') : staleRows ? '<div class="notice">El carrito tiene productos que ya no están disponibles.</div>' : `<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">▱</span><h3>Tu carrito está vacío.</h3><p>Explorá el catálogo y agregá productos disponibles. También podés pedir una cotización mayorista sin iniciar una compra.</p><a class="button button-dark" href="/catalogo">Ir al catálogo</a></div>`;
  const checkout = entries.length && (unavailableItems || lostItems) ? `<div class="notice">Quitá los productos retirados o que no estén disponibles para compra antes de continuar.</div>` : entries.length ? `<form class="cart-customer-form form-card" id="checkout-form"><h2>Datos de entrega</h2><p class="form-intro">Completá los datos para registrar el pedido. El importe cobrado queda bloqueado hasta que DAYBREAKER cotice el flete y vos aceptes el total.</p>
    <div class="form-grid">
      <div class="field"><label for="order-name">Nombre y apellido</label><input id="order-name" name="customerName" autocomplete="name" maxlength="120" required></div>
      <div class="field"><label for="order-email">Email</label><input id="order-email" name="email" type="email" autocomplete="email" maxlength="254" required></div>
      <div class="field"><label for="order-phone">Teléfono</label><input id="order-phone" name="phone" autocomplete="tel" maxlength="80" required></div>
      <div class="field"><label for="order-postal">Código postal</label><input id="order-postal" name="postalCode" autocomplete="postal-code" maxlength="24" required></div>
      <div class="field field-full"><label for="order-address">Domicilio de entrega</label><input id="order-address" name="address" autocomplete="street-address" maxlength="240" required></div>
      <div class="field"><label for="order-locality">Localidad</label><input id="order-locality" name="locality" autocomplete="address-level2" maxlength="120" required></div>
      <div class="field"><label for="order-province">Provincia</label><input id="order-province" name="province" autocomplete="address-level1" maxlength="120" required></div>
      <div class="field field-full"><label for="order-notes">Observaciones</label><textarea id="order-notes" name="notes" maxlength="1000" placeholder="Indicaciones para la entrega (opcional)"></textarea></div>
    </div>
    <div class="notice notice-dark notice-cart-total">El total inicial de <strong>${money(total)}</strong> corresponde solo a productos. El pago no se habilita hasta que recibas y aceptes el flete cotizado.</div>
    <div id="checkout-error" class="form-error" role="alert" hidden></div>
    <div class="form-actions"><button class="button button-accent" type="submit">Enviar pedido para cotizar el flete</button><span class="field-help">Compra sin registro · Seguimiento privado por enlace.</span></div>
  </form>` : '';
  return shell(`<section class="section"><div class="section-shell"><div class="section-heading"><span class="eyebrow">Carrito y seguimiento</span><h1>Tu compra, paso a paso.</h1><p>Revisá cantidades, completá el destino y recibí una cotización de envío antes de pagar.</p></div>
    <div class="cart-layout"><div><div class="cart-items">${itemsMarkup}${staleRows}</div>${lostItems ? '<p class="form-error">Un producto ya no está disponible. Quitalo del carrito para continuar.</p>' : ''}${checkout}</div>
      <aside class="cart-summary"><h2>Resumen</h2><div class="summary-row"><span>Productos</span><strong>${money(total)}</strong></div><div class="summary-row"><span>Envío</span><strong>A cotizar</strong></div><div class="summary-row summary-total"><span>Total a pagar</span><strong>A confirmar</strong></div><p class="field-help">El total final se muestra después de la cotización de flete.</p><hr class="form-divider"><h3 class="cart-track-heading">¿Ya tenés un pedido?</h3><p class="field-help">Abrí el enlace privado que recibiste para consultar su estado.</p><button class="button button-outline button-small" type="button" data-action="open-track">Consultar seguimiento</button></aside>
    </div>
    <div class="section-compact"><div class="panel-card"><h2>Seguimiento seguro</h2><p class="form-intro">El número de pedido por sí solo no permite acceder a tus datos. El seguimiento usa un enlace privado no adivinable.</p><form id="manual-track-form" class="form-grid"><div class="field"><label for="track-code">Código de pedido</label><input id="track-code" name="id" maxlength="32" required></div><div class="field"><label for="track-token">Token del enlace privado</label><input id="track-token" name="token" minlength="40" maxlength="100" required></div><div class="field field-full"><button class="button button-dark" type="submit">Consultar pedido</button></div><div id="track-error" class="form-error field-full" role="alert" hidden></div></form></div></div>
  </div></section>`, 'carrito');
}

function contactPage() {
  const emailMarkup = state.config.contactEmail
    ? `<a href="mailto:${encodeURIComponent(state.config.contactEmail)}">${escapeHtml(state.config.contactEmail)}</a>`
    : '<p>El email comercial autorizado se publicará cuando DAYBREAKER confirme los datos de contacto.</p>';
  const phoneMarkup = state.config.whatsappPhone
    ? `<a href="https://wa.me/${escapeHtml(state.config.whatsappPhone)}" target="_blank" rel="noopener noreferrer">Abrir WhatsApp ↗</a>`
    : '<p>El canal de WhatsApp estará disponible cuando se confirme el número comercial.</p>';
  return shell(`<section class="section"><div class="section-shell"><div class="section-heading"><span class="eyebrow">Contacto</span><h1>Hablemos de tu consulta.</h1><p>Para consultas minoristas, mayoristas o de seguimiento, elegí el canal disponible.</p></div>
    <div class="contact-layout"><div class="contact-grid">
      <article class="contact-card"><span class="contact-icon" aria-hidden="true">@</span><h3>Email</h3>${emailMarkup}</article>
      <article class="contact-card"><span class="contact-icon" aria-hidden="true">W</span><h3>WhatsApp</h3>${phoneMarkup}<p>Las respuestas comerciales se gestionan manualmente.</p></article>
    </div><aside class="quote-side"><span class="eyebrow">Cobertura</span><h3>Atención en toda Argentina</h3><p>El transporte se cotiza previamente según destino, volumen y cantidad. No se cobra el total hasta que el cliente acepta la cotización.</p><a class="button button-accent quote-side-cta" href="/presupuestos-mayoristas">Pedir un presupuesto</a></aside></div>
  </div></section>`, 'contacto');
}

function statusBadge(status) {
  const label = statusText[status] || status;
  const className = ['canceled', 'failed'].includes(status) ? 'badge badge-warn' : ['confirmed', 'payment_confirmed', 'delivered'].includes(status) ? 'badge' : 'badge badge-muted';
  return `<span class="${className}">${escapeHtml(label)}</span>`;
}

function trackingTimeline(status) {
  const steps = [
    ['received', 'Recibido'], ['freight_quoted', 'Flete cotizado'], ['payment_confirmed', 'Pago confirmado'], ['preparing', 'Preparación'], ['dispatched', 'Despachado / entregado'],
  ];
  const rank = { received: 0, freight_quoted: 1, awaiting_payment: 1, payment_confirmed: 2, preparing: 3, dispatched: 4, delivered: 4, canceled: -1 };
  const current = rank[status] ?? 0;
  if (status === 'canceled') return `<div class="notice tracking-cancel-notice">Este pedido fue cancelado.</div>`;
  return `<div class="tracking-timeline" aria-label="Estado del pedido">${steps.map(([key, label], index) => `<div class="timeline-step ${index <= current ? 'done' : ''}">${label}</div>`).join('')}</div>`;
}

function trackingResult(order, token) {
  const paymentReturn = sessionStorage.getItem(`daybreaker-payment-return-${order.id}`);
  const paymentMessage = paymentReturn
    ? `<div class="notice notice-dark payment-return-notice">Volviste de Mercado Pago. El retorno del navegador no confirma un pago; el estado se actualizará cuando el servidor verifique la notificación oficial. Estado recibido: ${escapeHtml(paymentReturn)}.</div>`
    : '';
  const items = order.items.map(item => `<li><span>${escapeHtml(item.name)} × ${item.quantity}</span><strong>${money(item.lineTotalCents)}</strong></li>`).join('');
  const paymentRows = order.payments.length ? `<div class="tracking-items"><h3 class="payment-list-heading">Pagos registrados</h3>${order.payments.map(payment => `<li><span>${payment.method === 'transfer' ? 'Transferencia' : 'Mercado Pago'} · ${escapeHtml(statusText[payment.status] || payment.status)}</span><strong>${money(payment.amountCents)}</strong></li>`).join('')}</div>` : '';
  const canAccept = order.status === 'freight_quoted' && order.freightCents !== null;
  const canPay = order.status === 'awaiting_payment' && order.freightAccepted;
  const existingTransfer = order.payments.find(payment => payment.method === 'transfer' && payment.status === 'pending_verification');
  const existingMp = order.payments.find(payment => payment.method === 'mercadopago' && payment.status === 'pending');
  const payPanel = canPay ? `<section class="payment-panel"><h3>Elegí cómo pagar</h3><p>El total aceptado es ${money(order.totalCents)}. DAYBREAKER verificará el pago antes de confirmar el pedido.</p>
    <div class="payment-methods">
      ${order.paymentOptions.transfer ? `<button class="button button-outline button-small" type="button" data-action="pay-transfer" data-order-id="${escapeHtml(order.id)}">${existingTransfer ? 'Ver datos de transferencia' : 'Transferencia bancaria'}</button>` : ''}
      ${order.paymentOptions.mercadopago ? `<button class="button button-accent button-small" type="button" data-action="pay-mercadopago" data-order-id="${escapeHtml(order.id)}">${existingMp ? 'Continuar con Mercado Pago' : 'Mercado Pago'}</button>` : ''}
      ${!order.paymentOptions.transfer && !order.paymentOptions.mercadopago ? '<span class="notice">Los medios de pago se habilitarán cuando DAYBREAKER configure sus cuentas autorizadas.</span>' : ''}
    </div><div id="bank-details"></div></section>` : '';
  return `<article class="panel-card tracking-card">
    <div class="tracking-header"><div><span class="field-help">Código de pedido</span><h2>${escapeHtml(order.id)}</h2></div>${statusBadge(order.status)}</div>
    ${paymentMessage}${trackingTimeline(order.status)}
    <div class="tracking-info">
      <div class="info-tile"><span>Cliente</span><strong>${escapeHtml(order.customerName)}</strong></div>
      <div class="info-tile"><span>Destino</span><strong>${escapeHtml(order.locality)}, ${escapeHtml(order.province)} · CP ${escapeHtml(order.postalCode)}</strong></div>
      <div class="info-tile"><span>Fecha</span><strong>${dateTime(order.createdAt)}</strong></div>
      <div class="info-tile"><span>Flete</span><strong>${money(order.freightCents)}</strong></div>
      ${order.carrier ? `<div class="info-tile"><span>Transportista</span><strong>${escapeHtml(order.carrier)}</strong></div>` : ''}
      ${order.shipmentTracking ? `<div class="info-tile"><span>Seguimiento de envío</span><strong>${escapeHtml(order.shipmentTracking)}</strong></div>` : ''}
    </div>
    <h3 class="tracking-products-heading">Productos</h3><ul class="tracking-items">${items}</ul>
    <div class="summary-row"><span>Subtotal de productos</span><strong>${money(order.subtotalCents)}</strong></div>
    <div class="summary-row"><span>Flete</span><strong>${money(order.freightCents)}</strong></div>
    <div class="summary-row summary-total"><span>Total</span><strong>${money(order.totalCents)}</strong></div>
    ${canAccept ? `<section class="payment-panel"><h3>El flete ya fue cotizado.</h3><p>Revisá el total final y aceptalo para habilitar los medios de pago.</p><p><strong>Productos ${money(order.subtotalCents)} + flete ${money(order.freightCents)} = ${money(order.totalCents)}</strong></p><button class="button button-accent button-small" type="button" data-action="accept-freight" data-order-id="${escapeHtml(order.id)}">Aceptar total y continuar</button></section>` : ''}
    ${payPanel}${paymentRows}
  </article>`;
}

async function trackingPage() {
  navActive('carrito');
  const orderId = decodeURIComponent(window.location.pathname.split('/').pop() || '');
  const token = window.location.hash.slice(1);
  let details = '';
  if (token && orderId) {
    try {
      const order = await api('/api/track', { method: 'POST', body: { id: orderId, token } });
      details = trackingResult(order, token);
    } catch (error) {
      details = `<div class="notice" role="alert">${escapeHtml(error.message)}</div>`;
    }
  } else {
    details = `<div class="panel-card tracking-card"><h2>Usá tu enlace privado</h2><p class="form-intro">Ingresá el código y el token que aparecen en el enlace de seguimiento que recibiste. El código de pedido por sí solo no permite ver tus datos.</p><form id="manual-track-form" class="form-grid"><div class="field"><label for="track-code">Código de pedido</label><input id="track-code" name="id" value="${escapeHtml(orderId)}" maxlength="32" required></div><div class="field"><label for="track-token">Token del enlace privado</label><input id="track-token" name="token" minlength="40" maxlength="100" required></div><div class="field field-full"><button class="button button-dark" type="submit">Consultar pedido</button></div><div id="track-error" class="form-error field-full" role="alert" hidden></div></form></div>`;
  }
  return `<section class="section"><div class="section-shell"><div class="section-heading"><span class="eyebrow">Carrito y seguimiento</span><h1>Seguimiento de pedido</h1><p>Consultá el estado y el total de tu compra con el enlace privado que recibiste.</p></div>${details}<div class="tracking-back"><a class="button button-outline" href="/carrito">Volver al carrito</a></div></div></section>`;
}

function paymentReturnPage() {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('pedido') || '';
  const result = params.get('estado') || 'pendiente';
  const token = sessionStorage.getItem(`daybreaker-tracking-${orderId}`);
  if (orderId && token) {
    sessionStorage.setItem(`daybreaker-payment-return-${orderId}`, result);
    window.history.replaceState({}, '', `/seguimiento/${encodeURIComponent(orderId)}#${encodeURIComponent(token)}`);
    return trackingPage();
  }
  return `<section class="section"><div class="section-shell"><div class="section-heading"><span class="eyebrow">Estado de pago</span><h1>Estamos verificando el pago.</h1><p>El retorno del navegador desde Mercado Pago no confirma que el pago haya sido aprobado. La confirmación se registra cuando el servidor valida la notificación oficial.</p></div><div class="notice notice-dark">Guardá el enlace privado de seguimiento que recibiste con el pedido para consultar el estado actualizado.</div><a class="button button-dark payment-return-back" href="/carrito">Volver al sitio</a></div></section>`;
}

function moneyStatus(order) { return statusText[order.status] || order.status; }

function productForm(product = null) {
  const editing = Boolean(product);
  const categories = state.admin.categories;
  const categoryId = product?.categoryId || '';
  const chosenCategory = categories.find(category => category.id === categoryId);
  return `<form class="admin-product-form" id="admin-product-form" data-product-id="${editing ? escapeHtml(product.id) : ''}">
    <div class="admin-form-heading"><div><span class="eyebrow">${editing ? 'Ficha existente' : 'Nuevo registro'}</span><h2>${editing ? 'Editar producto' : 'Alta de producto'}</h2>${editing ? `<p>Estás editando: <strong>${escapeHtml(product.name)}</strong></p>` : '<p>Administra los datos y la visibilidad de la tienda.</p>'}</div>${editing ? '<button class="button button-outline button-small" type="button" data-action="cancel-product-edit">Cancelar</button>' : ''}</div>
    <div class="admin-product-grid">
      <div class="field field-full"><label for="admin-product-name">Nombre del producto</label><input id="admin-product-name" name="name" value="${escapeHtml(product?.name || '')}" maxlength="120" required></div>
      <div class="field"><label for="admin-product-category">Categoría</label><div class="admin-select-add"><select id="admin-product-category" name="categoryId"><option value="">Sin categoría</option>${categories.map(category => `<option value="${escapeHtml(category.id)}" ${category.id === categoryId ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select><button class="button button-outline button-small" type="button" data-action="add-category" aria-label="Crear categoría">+</button></div></div>
      <div class="field"><label for="admin-product-subcategory">Subcategoría o línea</label><div class="admin-select-add"><select id="admin-product-subcategory" name="subcategoryId"><option value="">Sin subcategoría</option>${(chosenCategory?.subcategories || []).map(sub => `<option value="${escapeHtml(sub.id)}" ${sub.id === product?.subcategoryId ? 'selected' : ''}>${escapeHtml(sub.name)}</option>`).join('')}</select><button class="button button-outline button-small" type="button" data-action="add-subcategory" ${chosenCategory ? '' : 'disabled'} aria-label="Crear subcategoría">+</button></div></div>
      <div class="field"><label for="admin-product-stock">Stock disponible</label><input id="admin-product-stock" name="stockQuantity" type="number" min="0" step="1" value="${product?.stockQuantity ?? 0}" required></div>
      <div class="field"><label for="admin-product-price">Precio minorista (ARS)</label><input id="admin-product-price" name="retailPrice" value="${product ? moneyInput(product.retailPriceCents) : ''}" inputmode="decimal" placeholder="12.345,67" required></div>
      <div class="field"><label for="admin-product-availability">Disponibilidad comercial</label><select id="admin-product-availability" name="availability"><option value="available" ${product?.availability === 'available' ? 'selected' : ''}>Disponible</option><option value="sold_out" ${product?.availability === 'sold_out' ? 'selected' : ''}>Agotado</option><option value="on_request" ${product?.availability === 'on_request' ? 'selected' : ''}>A pedido</option></select></div>
      <div class="field field-full"><label for="admin-product-image">Imagen principal (URL segura)</label><input id="admin-product-image" name="imageUrl" type="url" value="${escapeHtml(product?.imageUrl || '')}" placeholder="https://..."></div>
      <div class="field field-full"><span class="field-label">Galeria de imagenes, hasta seis</span><div class="admin-image-drop" data-image-drop><label for="admin-product-files">Arrastra imagenes aqui o <span>busca archivos</span><input id="admin-product-files" data-product-images type="file" accept="image/jpeg,image/png,image/webp" multiple></label><small>Formatos permitidos: JPEG, PNG o WebP. Tamaño máximo: 4 MB por imagen. Hasta 6 imágenes por producto.</small><div class="admin-image-grid" data-selected-preview></div></div><div class="admin-image-grid">${(product?.images || []).map(image => `<div class="admin-image-card"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.altText || product.name)}"><div><button type="button" data-action="set-primary-image" data-product-id="${escapeHtml(product.id)}" data-image-id="${escapeHtml(image.id)}" aria-label="Usar como portada" title="Usar como portada">${image.isPrimary ? 'Portada' : '☆'}</button><button type="button" data-action="remove-product-image" data-product-id="${escapeHtml(product.id)}" data-image-id="${escapeHtml(image.id)}" aria-label="Quitar imagen" title="Quitar imagen">×</button></div></div>`).join('')}</div></div>
      <div class="field field-full"><label for="admin-product-description">Descripción</label><textarea id="admin-product-description" name="shortDescription" maxlength="1000">${escapeHtml(product?.shortDescription || '')}</textarea></div>
      <div class="field field-full"><label for="admin-product-specs">Especificaciones tecnicas</label><textarea id="admin-product-specs" name="specifications" maxlength="5000" placeholder="Capacidad: …&#10;Material: …&#10;Dimensiones: …">${escapeHtml(product?.specifications || '')}</textarea><small>Formato libre: adaptalo a cada producto.</small></div>
      <div class="field field-full"><span class="field-label">Atributos del producto</span><div class="admin-attributes">${(product?.attributes || []).map(attribute => `<div class="admin-attribute-row" data-attribute-row><input name="attributeName" aria-label="Nombre del atributo" placeholder="Ej. Material" value="${escapeHtml(attribute.name)}"><input name="attributeValue" aria-label="Valor del atributo" placeholder="Ej. Acero" value="${escapeHtml(attribute.value)}"><button class="admin-icon-button danger" type="button" data-action="remove-attribute" aria-label="Quitar atributo">×</button></div>`).join('')}</div><button class="button button-outline button-small" type="button" data-action="add-attribute">Agregar atributo</button><small>Agrega solo propiedades relevantes para este producto.</small></div>
      <label class="field-full admin-visibility"><input type="checkbox" name="visibleInStore" ${product?.visibleInStore !== false ? 'checked' : ''}> Mostrar este producto en la tienda</label>
    </div><div id="admin-product-error" class="form-error" role="alert" hidden></div><div class="form-actions"><button class="button button-accent" type="submit">${editing ? 'Guardar cambios' : 'Crear producto'}</button></div>
  </form>`;
}

function renderProductCatalog() {
  const admin = state.admin; const category = admin.categories.find(item => item.id === admin.productCategory);
  const products = admin.productCategory ? admin.products.filter(product => (admin.productCategory === '__none__' ? !product.categoryId : product.categoryId === admin.productCategory) && (!admin.productVisibility || (admin.productVisibility === 'archived' ? !product.active : product.active && (admin.productVisibility === 'visible' ? product.visibleInStore : !product.visibleInStore)))) : [];
  const list = !admin.productCategory ? '<div class="admin-catalog-empty"><strong>Elegí una categoría</strong><span>Seleccioná una categoría para ver sus productos.</span></div>' : products.length ? products.map(product => `<article class="admin-product-row"><div class="admin-product-thumb">${product.imageUrl ? `<img src="${escapeHtml(product.imageUrl)}" alt="" loading="lazy">` : '<span>DB</span>'}</div><div class="admin-product-info"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.categoryName || category?.name || 'Sin categoría')}${product.subcategoryName ? ` ? ${escapeHtml(product.subcategoryName)}` : ''}</small><b>${money(product.retailPriceCents)}</b><span class="badge ${!product.active ? 'badge-muted' : product.visibleInStore ? 'badge-success' : 'badge-muted'}">${!product.active ? 'Archivado' : product.visibleInStore ? 'Visible' : 'Oculto'}</span></div><div class="admin-product-tools"><button class="admin-icon-button" type="button" data-action="edit-product" data-product-id="${escapeHtml(product.id)}" aria-label="Editar ${escapeHtml(product.name)}" title="Editar">&#9998;</button>${product.active ? `<button class="admin-icon-button" type="button" data-action="toggle-visibility" data-product-id="${escapeHtml(product.id)}" aria-label="${product.visibleInStore ? 'Ocultar' : 'Mostrar'} ${escapeHtml(product.name)}" title="${product.visibleInStore ? 'Ocultar' : 'Mostrar'}">${product.visibleInStore ? '&#9673;' : '&#8856;'}</button><button class="admin-icon-button danger" type="button" data-action="archive-product" data-product-id="${escapeHtml(product.id)}" aria-label="Archivar ${escapeHtml(product.name)}" title="Archivar">&#128465;</button>` : ''}</div></article>`).join('') : '<div class="admin-catalog-empty"><strong>Sin productos</strong><span>No hay productos para este filtro.</span></div>';
  return `<section class="admin-catalog"><div class="admin-toolbar"><div><span class="eyebrow">Inventario comercial</span><h2>Productos cargados</h2></div><span class="badge badge-muted">${products.length}</span></div><div class="admin-catalog-filters"><label><span>Categoría</span><select class="filter-control" data-product-category><option value="">Seleccionar categoría</option><option value="__none__" ${admin.productCategory === '__none__' ? 'selected' : ''}>Sin categoría</option>${admin.categories.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === admin.productCategory ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label><span>Estado</span><select class="filter-control" data-product-visibility><option value="">Todos</option><option value="visible" ${admin.productVisibility === 'visible' ? 'selected' : ''}>Visibles</option><option value="hidden" ${admin.productVisibility === 'hidden' ? 'selected' : ''}>Ocultos</option><option value="archived" ${admin.productVisibility === 'archived' ? 'selected' : ''}>Archivados</option></select></label></div><div class="admin-product-list">${list}</div></section>`;
}

function orderCard(order) {
  const paymentList = order.payments.length ? order.payments.map(payment => `<div class="admin-meta"><span>${payment.method === 'transfer' ? 'Transferencia' : 'Mercado Pago'}</span><span>${money(payment.amountCents)}</span><span>${escapeHtml(statusText[payment.status] || payment.status)}</span>${payment.providerReference ? `<span>Ref. ${escapeHtml(payment.providerReference)}</span>` : ''}</div>${payment.method === 'transfer' && payment.status === 'pending_verification' ? `<button class="button button-outline button-small" type="button" data-action="confirm-transfer" data-payment-id="${escapeHtml(payment.id)}">Confirmar transferencia verificada</button>` : ''}`).join('') : '<p>Sin pagos registrados.</p>';
  const hasActivePayment = order.payments.some(payment => payment.status !== 'failed');
  const statusChoices = order.status === 'payment_confirmed' ? ['preparing']
    : order.status === 'preparing' ? ['dispatched']
      : order.status === 'dispatched' ? ['delivered']
        : hasActivePayment ? [] : ['canceled'];
  const canQuote = !['payment_confirmed', 'preparing', 'dispatched', 'delivered', 'canceled'].includes(order.status) && !order.payments.some(payment => payment.status !== 'failed');
  const customerPhone = order.phone.replace(/\D/g, '');
  return `<article class="admin-item">
    <div class="admin-item-head"><div><h3>Pedido ${escapeHtml(order.id)}</h3><p>${escapeHtml(order.customerName)} · ${escapeHtml(order.email)} · ${escapeHtml(order.phone)}</p></div>${statusBadge(order.status)}</div>
    <div class="admin-meta"><span>${dateTime(order.createdAt)}</span><span>${escapeHtml(order.locality)}, ${escapeHtml(order.province)} · CP ${escapeHtml(order.postalCode)}</span><span>Productos ${money(order.subtotalCents)}</span><span>Flete ${money(order.freightCents)}</span><strong>Total ${money(order.totalCents)}</strong></div>
    <div class="admin-actions"><a class="button button-outline button-small" href="mailto:${encodeURIComponent(order.email)}?subject=${encodeURIComponent(`Pedido DAYBREAKER ${order.id}`)}">Contactar por email</a>${customerPhone ? `<a class="button button-outline button-small" target="_blank" rel="noopener noreferrer" href="https://wa.me/${escapeHtml(customerPhone)}?text=${encodeURIComponent(`Hola, te contacto por tu pedido DAYBREAKER ${order.id}.`)}">Abrir WhatsApp</a>` : ''}</div>
    <details class="admin-details"><summary>Ver productos y datos de entrega</summary><p><strong>Domicilio:</strong> ${escapeHtml(order.address)}</p><p><strong>Productos:</strong> ${order.items.map(item => `${escapeHtml(item.name)} × ${item.quantity} (${money(item.lineTotalCents)})`).join(' · ')}</p>${order.notes ? `<p><strong>Observaciones:</strong> ${escapeHtml(order.notes)}</p>` : ''}${order.carrier ? `<p><strong>Transportista:</strong> ${escapeHtml(order.carrier)} ${escapeHtml(order.shipmentTracking)}</p>` : ''}<p><strong>Enlace de seguimiento:</strong> se vuelve a mostrar al cliente al crear el pedido; por seguridad no se almacena el token en el panel.</p></details>
    <div class="admin-details"><strong class="admin-payment-label">Pagos</strong>${paymentList}</div>
    ${canQuote ? `<form class="admin-inline-form" data-admin-form="freight" data-order-id="${escapeHtml(order.id)}"><div class="field"><label>Flete (ARS)</label><input name="freight" inputmode="decimal" placeholder="12.345,67" required></div><div class="field"><label>Transportista (opcional)</label><input name="carrier" maxlength="120"></div><div class="field"><label>N.º seguimiento (opcional)</label><input name="shipmentTracking" maxlength="180"></div><button class="button button-accent button-small" type="submit">Informar flete</button></form>` : ''}
    ${order.status !== 'delivered' && order.status !== 'canceled' && statusChoices.length ? `<form class="admin-inline-form" data-admin-form="order-status" data-order-id="${escapeHtml(order.id)}"><div class="field"><label>Actualizar estado</label><select name="status">${statusChoices.filter(value => value !== order.status).map(value => `<option value="${value}">${escapeHtml(statusText[value])}</option>`).join('')}</select></div><button class="button button-outline button-small" type="submit">Guardar estado</button></form>` : ''}
  </article>`;
}

function quoteCard(quote) {
  const customerPhone = quote.phone.replace(/\D/g, '');
  return `<article class="admin-item">
    <div class="admin-item-head"><div><h3>Solicitud ${escapeHtml(quote.id)}</h3><p>${escapeHtml(quote.companyName || quote.contactName)}${quote.companyName && quote.contactName ? ` · ${escapeHtml(quote.contactName)}` : ''}</p></div>${statusBadge(quote.status)}</div>
    <div class="admin-meta"><span>${dateTime(quote.createdAt)}</span><span>${escapeHtml(quote.email)}</span><span>${escapeHtml(quote.phone)}</span><span>${escapeHtml(quote.destination)}</span>${quote.cuit ? `<span>CUIT ${escapeHtml(quote.cuit)}</span>` : ''}</div>
    <details class="admin-details"><summary>Ver productos y observaciones</summary><p><strong>Productos:</strong> ${quote.items.map(item => `${escapeHtml(item.name)} × ${item.quantity}`).join(' · ')}</p>${quote.notes ? `<p><strong>Observaciones:</strong> ${escapeHtml(quote.notes)}</p>` : ''}</details>
    <div class="admin-actions"><a class="button button-outline button-small" href="mailto:${encodeURIComponent(quote.email)}?subject=${encodeURIComponent(`Presupuesto DAYBREAKER ${quote.id}`)}">Responder por email</a>${customerPhone ? `<a class="button button-outline button-small" target="_blank" rel="noopener noreferrer" href="https://wa.me/${escapeHtml(customerPhone)}?text=${encodeURIComponent(`Hola, te contacto por el presupuesto DAYBREAKER ${quote.id}.`)}">Abrir WhatsApp</a>` : ''}</div>
    <form class="admin-inline-form" data-admin-form="quote-status" data-quote-id="${escapeHtml(quote.id)}"><div class="field"><label>Estado interno</label><select name="status">${['pending','responded','closed'].map(value => `<option value="${value}" ${quote.status === value ? 'selected' : ''}>${escapeHtml(statusText[value])}</option>`).join('')}</select></div><button class="button button-outline button-small" type="submit">Guardar estado</button></form>
  </article>`;
}

function adminTabs(active) {
  const tabs = [['products', 'Productos'], ['orders', 'Pedidos'], ['quotes', 'Presupuestos']];
  return `<div class="admin-tabs" role="tablist" aria-label="Secciones del panel">${tabs.map(([key, label]) => `<button class="admin-tab" type="button" role="tab" aria-selected="${active === key}" data-action="admin-tab" data-tab="${key}">${label}</button>`).join('')}</div>`;
}

function filteredOrders() {
  const { query = '', status = '', date = '' } = state.admin.filter;
  return state.admin.orders.filter(order => {
    const haystack = `${order.id} ${order.customerName} ${order.email} ${order.phone} ${order.locality} ${order.province}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (!status || order.status === status) && (!date || order.createdAt.slice(0, 10) === date);
  });
}

function filteredQuotes() {
  const { query = '', status = '', date = '' } = state.admin.filter;
  return state.admin.quotes.filter(quote => {
    const haystack = `${quote.id} ${quote.companyName} ${quote.contactName} ${quote.email} ${quote.phone} ${quote.destination}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (!status || quote.status === status) && (!date || quote.createdAt.slice(0, 10) === date);
  });
}

function renderAdminContent() {
  const admin = state.admin;
  const key = admin.tab === 'products' ? 'products' : admin.tab;
  if (!admin.loaded[key]) {
    const error = admin.errors[key];
    return `<div class="admin-data-loading" role="status" aria-live="polite">${error ? `<div class="notice" role="alert">${escapeHtml(error)} <button class="button button-outline button-small" type="button" data-action="retry-admin-data">Reintentar</button></div>` : '<span class="loading-shell"><span class="loading-spinner"></span><span>Cargando esta sección…</span></span>'}</div>`;
  }
  if (admin.tab === 'products') {
    return `<div class="admin-products-layout">${productForm(admin.productEdit)}${renderProductCatalog()}</div>`;
  }
  if (admin.tab === 'orders') {
    const orders = filteredOrders();
    const list = orders.length ? `<div class="admin-list">${orders.map(orderCard).join('')}</div>` : '<div class="empty-state"><h3>No hay pedidos para mostrar.</h3><p>Los pedidos minoristas se guardan aquí de forma independiente de las solicitudes de presupuesto.</p></div>';
    return `<div class="admin-toolbar"><h2>Pedidos minoristas</h2><span class="badge badge-muted">${orders.length} encontrados</span></div>
      <form id="admin-filter-form" class="filter-row"><input class="filter-control" name="query" placeholder="Cliente, email o pedido" value="${escapeHtml(admin.filter.query || '')}"><select class="filter-control" name="status"><option value="">Todos los estados</option>${['received','freight_quoted','awaiting_payment','payment_confirmed','preparing','dispatched','delivered','canceled'].map(value => `<option value="${value}" ${admin.filter.status === value ? 'selected' : ''}>${escapeHtml(statusText[value])}</option>`).join('')}</select><input class="filter-control" type="date" name="date" aria-label="Filtrar por fecha" value="${escapeHtml(admin.filter.date || '')}"><button class="button button-dark button-small" type="submit">Filtrar</button><button class="button button-outline button-small" type="button" data-action="clear-admin-filter">Limpiar</button></form>${list}`;
  }
  const quotes = filteredQuotes();
  const list = quotes.length ? `<div class="admin-list">${quotes.map(quoteCard).join('')}</div>` : '<div class="empty-state"><h3>No hay presupuestos para mostrar.</h3><p>Las solicitudes mayoristas quedan almacenadas aparte de los pedidos.</p></div>';
  return `<div class="admin-toolbar"><h2>Solicitudes mayoristas</h2><span class="badge badge-muted">${quotes.length} encontradas</span></div><form id="admin-filter-form" class="filter-row"><input class="filter-control" name="query" placeholder="Empresa, contacto o email" value="${escapeHtml(admin.filter.query || '')}"><select class="filter-control" name="status"><option value="">Todos los estados</option>${['pending','responded','closed'].map(value => `<option value="${value}" ${admin.filter.status === value ? 'selected' : ''}>${escapeHtml(statusText[value])}</option>`).join('')}</select><input class="filter-control" type="date" name="date" aria-label="Filtrar por fecha" value="${escapeHtml(admin.filter.date || '')}"><button class="button button-dark button-small" type="submit">Filtrar</button><button class="button button-outline button-small" type="button" data-action="clear-admin-filter">Limpiar</button></form>${list}`;
}

function clearAdminPrivateData() {
  Object.assign(state.admin, { authenticated: false, authStatus: 'unauthenticated', validatedAt: 0, productEdit: null, orders: [], quotes: [], products: [], categories: [], loaded: {}, errors: {}, requests: {} });
}

function loadAdminResource(key) {
  const admin = state.admin;
  if (admin.loaded[key]) return Promise.resolve();
  if (admin.errors[key]) return Promise.resolve();
  if (admin.requests[key]) return admin.requests[key];
  const request = (async () => {
    try {
      if (key === 'products') {
        const requests = [api('/api/admin/products')];
        if (!admin.loaded.categories) requests.push(api('/api/admin/categories'));
        const [products, categories] = await Promise.all(requests);
        admin.products = products;
        if (categories) { admin.categories = categories; admin.loaded.categories = true; }
      } else if (key === 'orders') admin.orders = await api('/api/admin/orders');
      else if (key === 'quotes') admin.quotes = await api('/api/admin/quotes');
      admin.loaded[key] = true;
      delete admin.errors[key];
    } catch (error) {
      if (error.status === 401) clearAdminPrivateData();
      else admin.errors[key] = error.message;
    } finally {
      delete admin.requests[key];
      if (admin.routeActive) render();
    }
  })();
  admin.requests[key] = request;
  return request;
}

function ensureAdminRouteData() {
  const admin = state.admin;
  if (!admin.routeActive || !state.config.adminEnabled) return;
  if (admin.authStatus === 'authenticated') {
    loadAdminResource(admin.tab === 'products' ? 'products' : admin.tab);
    return;
  }
  if (admin.authStatus === 'checking' || admin.authStatus === 'unauthenticated') return;
  admin.authStatus = 'checking';
  admin.sessionRequest = api('/api/admin/session').then(session => {
    admin.authStatus = session.authenticated ? 'authenticated' : 'unauthenticated';
    admin.authenticated = session.authenticated;
    admin.validatedAt = Date.now();
  }).catch(() => {
    admin.authStatus = 'unauthenticated'; admin.authenticated = false; admin.validatedAt = 0;
  }).finally(() => {
    admin.sessionRequest = null;
    if (admin.routeActive) render();
  });
}

function adminPage() {
  navActive('');
  if (!state.config.adminEnabled) {
    return `<section class="admin-shell"><div class="section-shell"><div class="panel-card admin-login"><span class="eyebrow">Panel interno</span><h1 class="admin-login-title">Acceso no habilitado</h1><p class="form-intro">Configurá una contraseña administrativa en el archivo local .env para abrir el panel. La contraseña no tiene un valor predeterminado.</p><a class="button button-outline" href="/">Volver al sitio</a></div></div></section>`;
  }
  if (state.admin.authStatus === 'unknown' || state.admin.authStatus === 'checking') {
    return `<section class="admin-shell"><div class="section-shell"><div class="panel-card admin-login" role="status" aria-live="polite"><span class="eyebrow">Panel interno</span><h1 class="admin-login-title">Panel DAYBREAKER</h1><p class="form-intro">Verificando el acceso…</p><span class="loading-shell"><span class="loading-spinner"></span><span>Un momento</span></span></div></div></section>`;
  }
  if (state.admin.authStatus !== 'authenticated') {
    return `<section class="admin-shell"><div class="section-shell"><form id="admin-login-form" class="panel-card admin-login"><span class="eyebrow">Acceso restringido</span><h1 class="admin-login-title">Panel DAYBREAKER</h1><p class="form-intro">Ingresá tu usuario y contraseña internos.</p><div class="field"><label for="admin-username">Usuario</label><input id="admin-username" name="username" type="text" autocomplete="username" maxlength="100" required></div><div class="field"><label for="admin-password">Contraseña</label><input id="admin-password" name="password" type="password" autocomplete="current-password" minlength="16" required></div><div id="admin-login-error" class="form-error" role="alert" hidden></div><div class="form-actions"><button class="button button-dark" type="submit">Iniciar sesión</button><a class="button button-outline" href="/">Volver</a></div></form></div></section>`;
  }
  const content = renderAdminContent();
  const pendingOrders = state.admin.loaded.orders ? state.admin.orders.filter(order => !['delivered','canceled'].includes(order.status)).length : '—';
  const pendingQuotes = state.admin.loaded.quotes ? state.admin.quotes.filter(quote => quote.status === 'pending').length : '—';
  return `<section class="admin-shell"><div class="section-shell">
    <div class="admin-top"><div><span class="eyebrow">DAYBREAKER S.A.S.</span><h1>Panel administrador</h1><p>Administra los productos que se mostraran en la tienda.</p></div><div class="admin-top-actions"><a class="button button-outline" href="/">Ver tienda</a><button class="button button-outline" type="button" data-action="admin-logout">Cerrar sesion</button></div></div>
    <div class="feature-strip admin-summary"><div class="feature-cell"><strong>${state.admin.loaded.products ? state.admin.products.filter(product => product.active).length : "—"} productos activos</strong><span>Catálogo y precios minoristas</span></div><div class="feature-cell"><strong>${pendingOrders} pedidos abiertos</strong><span>Compras y pagos por verificar</span></div><div class="feature-cell"><strong>${pendingQuotes} presupuestos pendientes</strong><span>Consultas mayoristas</span></div></div>
    ${adminTabs(state.admin.tab)}<div id="admin-content">${content}</div>
  </div></section>`;
}

async function routePage() {
  const pathname = decodeURI(window.location.pathname);
  if ((pathname === '/' || pathname === '/index.html') && window.location.hash === '#admin') return adminPage();
  const publicRoutes = {
    '/': 'inicio', '/index.html': 'inicio', '/quienes-somos': 'quienes-somos',
    '/catalogo': 'catalogo', '/presupuestos-mayoristas': 'presupuestos',
    '/carrito': 'carrito', '/contacto': 'contacto',
  };
  const publicRoute = publicRoutes[pathname];
  if (publicRoute === 'inicio') return heroPage();
  if (publicRoute === 'quienes-somos') return aboutPage();
  if (publicRoute === 'catalogo') return catalogPage();
  if (publicRoute === 'presupuestos') return quotePage();
  if (publicRoute === 'carrito') return cartPage();
  if (publicRoute === 'contacto') return contactPage();
  if (pathname.startsWith('/productos/')) {
    const slug = pathname.slice('/productos/'.length);
    try { return productPageMarkup(await api(`/api/products/${encodeURIComponent(slug)}`)); }
    catch (error) { return `<section class="section"><div class="section-shell"><div class="empty-state"><h1>Producto no encontrado</h1><p>${escapeHtml(error.message)}</p><a class="button button-dark" href="/catalogo">Volver al catálogo</a></div></div></section>`; }
  }
  if (pathname.startsWith('/seguimiento/')) return trackingPage();
  if (pathname.startsWith('/pago/resultado')) return paymentReturnPage();
  const route = window.location.hash.replace(/^#/, '') || 'inicio';
  if (route === 'admin') return adminPage();
  if (route === 'quienes-somos') return aboutPage();
  if (route === 'catalogo') return catalogPage();
  if (route === 'presupuestos') return quotePage();
  if (route === 'carrito') return cartPage();
  if (route === 'contacto') return contactPage();
  return heroPage();
}

async function render() {
  const version = ++state.routeVersion;
  const pathname = window.location.pathname;
  const isAdminRoute = (pathname === '/' || pathname === '/index.html') && window.location.hash === '#admin';
  if (isAdminRoute && !state.admin.routeActive) state.admin.authStatus = 'unknown';
  if (isAdminRoute && state.admin.authStatus === 'authenticated' && Date.now() - state.admin.validatedAt > adminSessionMaxAgeMs) state.admin.authStatus = 'unknown';
  state.admin.routeActive = isAdminRoute;
  app.setAttribute('aria-busy', 'true');
  try {
    const content = await routePage();
    if (version !== state.routeVersion) return;
    app.innerHTML = content;
    app.setAttribute('aria-busy', 'false');
    if (isAdminRoute) ensureAdminRouteData();
    if (window.location.pathname === '/presupuestos-mayoristas' && state.quoteDraft.length) {
      document.querySelector('#quote-items')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  } catch (error) {
    if (version !== state.routeVersion) return;
    app.innerHTML = `<section class="section"><div class="section-shell"><div class="notice" role="alert">${escapeHtml(error.message || 'Ocurrió un problema al cargar la página.')}</div></div></section>`;
    app.setAttribute('aria-busy', 'false');
  }
}

function routeToTracking(id, token) {
  window.history.pushState({}, '', `/seguimiento/${encodeURIComponent(id)}#${encodeURIComponent(token)}`);
  render();
}

function quoteDraftFor(product) {
  const existing = state.quoteDraft.filter(item => item.productName || (item.productId && item.productId !== 'custom'));
  state.quoteDraft = [...existing, { productId: product.id, productName: product.name, quantity: 1 }];
  setRoute('presupuestos');
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action === 'admin') return setRoute('admin');
  if (action === 'add-cart') {
    const product = state.products.find(item => item.id === button.dataset.productId);
    if (!product || product.availability !== 'available') return showToast('Este producto no está disponible para compra.');
    state.cart[product.id] = (Number(state.cart[product.id]) || 0) + 1;
    saveCart(); showToast(`${product.name} se agregó al carrito.`);
    if (window.location.pathname === '/carrito') render();
    return;
  }
  if (action === 'remove-cart') {
    delete state.cart[button.dataset.productId]; saveCart(); render(); return;
  }
  if (action === 'quote-product') {
    const product = state.products.find(item => item.id === button.dataset.productId);
    if (product) quoteDraftFor(product);
    return;
  }
  if (action === 'add-quote-row') {
    const rows = [...document.querySelectorAll('[data-quote-row]')].map(row => ({
      productId: row.querySelector('[name="productId"]').value,
      productName: row.querySelector('[name="productName"]').value,
      quantity: row.querySelector('[name="quantity"]').value,
    }));
    state.quoteDraft = [...rows, { productId: state.products.length ? '' : 'custom', productName: '', quantity: 1 }];
    render(); return;
  }
  if (action === 'remove-quote-row') {
    const rows = [...document.querySelectorAll('[data-quote-row]')].filter(row => row !== button.closest('[data-quote-row]')).map(row => ({
      productId: row.querySelector('[name="productId"]').value,
      productName: row.querySelector('[name="productName"]').value,
      quantity: row.querySelector('[name="quantity"]').value,
    }));
    if (!rows.length) rows.push({ productId: state.products.length ? '' : 'custom', productName: '', quantity: 1 });
    state.quoteDraft = rows; render(); return;
  }
  if (action === 'open-track') {
    setRoute('carrito');
    setTimeout(() => document.querySelector('#manual-track-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
    return;
  }
  if (action === 'accept-freight') {
    const token = window.location.hash.slice(1);
    try {
      await api('/api/track/accept-freight', { method: 'POST', body: { id: button.dataset.orderId, token } });
      showToast('Aceptaste el total. Ya podés elegir un medio de pago.'); render();
    } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'pay-transfer' || action === 'pay-mercadopago') {
    const id = button.dataset.orderId;
    const token = window.location.hash.slice(1);
    button.disabled = true;
    try {
      const result = await api('/api/track/payment', { method: 'POST', body: { id, token, method: action === 'pay-transfer' ? 'transfer' : 'mercadopago' } });
      if (action === 'pay-transfer') {
        const target = document.querySelector('#bank-details');
        if (target) target.innerHTML = bankMarkup(result.bankDetails, result.payment.amountCents);
        showToast('La transferencia quedó pendiente de verificación.');
      } else if (result.checkoutUrl) {
        sessionStorage.setItem(`daybreaker-tracking-${id}`, token);
        window.location.assign(result.checkoutUrl);
      }
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
    return;
  }
  if (action === 'admin-tab') {
    state.admin.tab = button.dataset.tab;
    state.admin.productEdit = null;
    state.admin.filter = {};
    render(); return;
  }
  if (action === 'retry-admin-data') {
    const key = state.admin.tab === 'products' ? 'products' : state.admin.tab;
    delete state.admin.errors[key];
    loadAdminResource(key);
    render(); return;
  }
  if (action === 'edit-product') {
    state.admin.productEdit = state.admin.products.find(product => product.id === button.dataset.productId) || null;
    render(); return;
  }
  if (action === 'cancel-product-edit') { state.admin.productEdit = null; render(); return; }
  if (action === 'add-category') {
    const name = prompt('Nombre de la nueva categoria'); if (!name?.trim()) return;
    try { const category = await api('/api/admin/categories', { method: 'POST', body: { name: name.trim() } }); state.admin.categories.push(category);
      const formSelect = document.querySelector('#admin-product-category'); formSelect?.add(new Option(category.name, category.id)); if (formSelect) { formSelect.value = category.id; formSelect.dispatchEvent(new Event('change', { bubbles: true })); }
      const filter = document.querySelector('[data-product-category]'); filter?.add(new Option(category.name, category.id)); state.admin.productCategory = category.id;
      showToast('Categoria creada.');
    } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'add-subcategory') {
    const categoryId = document.querySelector('#admin-product-category')?.value; const name = prompt('Nombre de la subcategoria o linea'); if (!categoryId || !name?.trim()) return;
    try { const subcategory = await api(`/api/admin/categories/${categoryId}/subcategories`, { method: 'POST', body: { name: name.trim() } }); const category = state.admin.categories.find(item => item.id === categoryId); if (category) category.subcategories.push(subcategory); const select = document.querySelector('#admin-product-subcategory'); select?.add(new Option(subcategory.name, subcategory.id)); if (select) select.value = subcategory.id; showToast('Subcategoria creada.'); } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'toggle-visibility') {
    const product = state.admin.products.find(item => item.id === button.dataset.productId); if (!product) return;
    button.disabled = true;
    try { const saved = await api(`/api/admin/products/${product.id}`, { method: 'PUT', body: { ...product, retailPrice: (product.retailPriceCents / 100).toFixed(2), visibleInStore: !product.visibleInStore } }); Object.assign(product, saved); state.products = state.products.filter(item => item.id !== product.id); if (product.active && product.visibleInStore) state.products.push(product); showToast(product.visibleInStore ? 'Producto visible.' : 'Producto oculto.'); render(); } catch (error) { button.disabled = false; showToast(error.message); }
    return;
  }
  if (action === 'set-primary-image' || action === 'remove-product-image') {
    const productId = button.dataset.productId; const imageId = button.dataset.imageId;
    try {
      if (action === 'remove-product-image' && !confirm('Quitar esta imagen de la ficha?')) return;
      await api(`/api/admin/products/${productId}/images/${imageId}`, { method: action === 'set-primary-image' ? 'PUT' : 'DELETE', body: {} });
      state.admin.loaded.products = false; state.admin.productEdit = null; render(); loadAdminResource('products'); showToast(action === 'set-primary-image' ? 'Portada actualizada.' : 'Imagen quitada.');
    } catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'add-attribute') {
    const list = document.querySelector('.admin-attributes');
    if (list && list.children.length < 40) {
      const row = document.createElement('div'); row.className = 'admin-attribute-row'; row.dataset.attributeRow = '';
      row.innerHTML = '<input name="attributeName" aria-label="Nombre del atributo" placeholder="Ej. Material"><input name="attributeValue" aria-label="Valor del atributo" placeholder="Ej. Acero"><button class="admin-icon-button danger" type="button" data-action="remove-attribute" aria-label="Quitar atributo">×</button>';
      list.append(row); row.querySelector('input')?.focus();
    }
    return;
  }
  if (action === 'remove-attribute') { button.closest('[data-attribute-row]')?.remove(); return; }
  if (action === 'archive-product') {
    if (!confirm('¿Desactivar este producto del catálogo? Los pedidos anteriores conservarán su descripción e importe.')) return;
    try { await api(`/api/admin/products/${button.dataset.productId}`, { method: 'DELETE' }); const product = state.admin.products.find(item => item.id === button.dataset.productId); if (product) product.active = false; state.products = state.products.filter(item => item.id !== button.dataset.productId); showToast('Producto desactivado.'); render(); }
    catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'confirm-transfer') {
    if (!confirm('Confirmá esta transferencia solo después de verificar la acreditación en la cuenta bancaria.')) return;
    try { await api(`/api/admin/payments/${button.dataset.paymentId}/confirm`, { method: 'PUT', body: {} }); const order = state.admin.orders.find(item => item.payments?.some(payment => payment.id === button.dataset.paymentId)); if (order) { order.status = 'payment_confirmed'; const payment = order.payments.find(item => item.id === button.dataset.paymentId); if (payment) payment.status = 'confirmed'; } showToast('Transferencia confirmada.'); render(); }
    catch (error) { showToast(error.message); }
    return;
  }
  if (action === 'admin-logout') {
    try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch { /* se limpia la sesión visual aunque expire */ }
    clearAdminPrivateData(); showToast('Sesión cerrada.'); render(); return;
  }
  if (action === 'clear-admin-filter') { state.admin.filter = {}; render(); }
}

function bankMarkup(details, amountCents) {
  if (!details) return '<div class="notice">Los datos bancarios no están configurados todavía.</div>';
  const fields = [['Titular', details.accountHolder], ['Banco', details.bankName], ['CBU', details.cbu], ['Alias', details.alias], ['CUIT', details.cuit]].filter(([, value]) => value);
  return `<div class="bank-details"><strong>Transferí ${money(amountCents)}</strong>${fields.map(([label, value]) => `<div class="bank-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}<p class="field-help">El pedido sigue pendiente hasta que DAYBREAKER verifique la acreditación. El comprobante por sí solo no confirma el pago.</p></div>`;
}

async function handleSubmit(form) {
  const data = new FormData(form);
  if (form.id === 'admin-login-form') {
    const errorBox = document.querySelector('#admin-login-error');
    errorBox.hidden = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: { username: data.get('username'), password: data.get('password') } });
      state.admin.authenticated = true; state.admin.authStatus = 'authenticated'; state.admin.validatedAt = Date.now(); showToast('Sesión iniciada.'); render();
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    return;
  }
  if (form.id === 'quote-form') {
    const errorBox = document.querySelector('#quote-error');
    errorBox.hidden = true;
    const rows = [...form.querySelectorAll('[data-quote-row]')].map(row => {
      const productId = row.querySelector('[name="productId"]').value;
      return {
        productId: productId && productId !== 'custom' ? productId : '',
        productName: row.querySelector('[name="productName"]').value.trim(),
        quantity: Number(row.querySelector('[name="quantity"]').value),
      };
    });
    try {
      const result = await api('/api/quotes', { method: 'POST', body: {
        companyName: data.get('companyName'), contactName: data.get('contactName'), cuit: data.get('cuit'),
        phone: data.get('phone'), email: data.get('email'), destination: data.get('destination'),
        items: rows, notes: data.get('notes'),
      } });
      document.querySelector('#quote-result').innerHTML = `<div class="form-success">Solicitud <strong>${escapeHtml(result.id)}</strong> registrada el ${dateTime(result.createdAt)}. DAYBREAKER te responderá por email o WhatsApp.</div>`;
      form.reset(); state.quoteDraft = [{ productId: state.products.length ? '' : 'custom', productName: '', quantity: 1 }];
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    return;
  }
  if (form.id === 'checkout-form') {
    const errorBox = document.querySelector('#checkout-error');
    errorBox.hidden = true;
    const items = Object.entries(state.cart).filter(([, amount]) => Number(amount) > 0).map(([productId, amount]) => ({ productId, quantity: Number(amount) }));
    try {
      const order = await api('/api/orders', { method: 'POST', body: {
        customerName: data.get('customerName'), email: data.get('email'), phone: data.get('phone'),
        address: data.get('address'), province: data.get('province'), locality: data.get('locality'),
        postalCode: data.get('postalCode'), notes: data.get('notes'), items,
      } });
      state.cart = {}; saveCart();
      const [path, hash] = order.trackingUrl.split('#');
      window.history.pushState({}, '', `${path}#${hash}`);
      showToast(`Pedido ${order.id} registrado. El pago espera la cotización de flete.`);
      render();
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; }
    return;
  }
  if (form.id === 'manual-track-form') {
    const errorBox = document.querySelector('#track-error');
    if (errorBox) errorBox.hidden = true;
    const id = String(data.get('id') || '').trim();
    const token = String(data.get('token') || '').trim();
    try {
      await api('/api/track', { method: 'POST', body: { id, token } });
      routeToTracking(id, token);
    } catch (error) {
      if (errorBox) { errorBox.textContent = error.message; errorBox.hidden = false; }
      else showToast(error.message);
    }
    return;
  }
  if (form.id === 'admin-product-form') {
    const errorBox = document.querySelector('#admin-product-error');
    errorBox.hidden = true;
    if (!form.dataset.saving) {
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true; form.dataset.saving = 'true';
    const body = {
      name: data.get('name'), retailPrice: data.get('retailPrice'), imageUrl: data.get('imageUrl'),
      availability: data.get('availability'), shortDescription: data.get('shortDescription'), specifications: data.get('specifications'),
      categoryId: data.get('categoryId'), subcategoryId: data.get('subcategoryId'), stockQuantity: Number(data.get('stockQuantity')),
      visibleInStore: data.get('visibleInStore') === 'on',
      attributes: [...form.querySelectorAll('[data-attribute-row]')].map(row => ({ name: row.querySelector('[name="attributeName"]').value.trim(), value: row.querySelector('[name="attributeValue"]').value.trim() })).filter(attribute => attribute.name && attribute.value),
    };
    const originalProduct = form.dataset.productId ? state.admin.products.find(item => item.id === form.dataset.productId) : null;
    if (originalProduct) body.active = originalProduct.active;
    const files = [...(form.querySelector('[data-product-images]')?.files || [])];
    if ((originalProduct?.images?.length || 0) + files.length > 6) { errorBox.textContent = 'Cada producto puede tener hasta seis imagenes.'; errorBox.hidden = false; submitButton.disabled = false; delete form.dataset.saving; return; }
    if (files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024)) { errorBox.textContent = 'Usa JPEG, PNG o WebP de hasta 4 MB por imagen.'; errorBox.hidden = false; submitButton.disabled = false; delete form.dataset.saving; return; }
    try {
      const path = form.dataset.productId ? `/api/admin/products/${form.dataset.productId}` : '/api/admin/products';
      const saved = await api(path, { method: form.dataset.productId ? 'PUT' : 'POST', body });
      const existingIndex = state.admin.products.findIndex(item => item.id === saved.id);
      const existingProduct = existingIndex >= 0 ? state.admin.products[existingIndex] : null;
      const category = state.admin.categories.find(item => item.id === saved.categoryId);
      const subcategory = category?.subcategories?.find(item => item.id === saved.subcategoryId);
      const cachedProduct = { ...existingProduct, ...saved, images: existingProduct?.images || [], categoryName: category?.name || existingProduct?.categoryName || '', subcategoryName: subcategory?.name || existingProduct?.subcategoryName || '' };
      if (existingIndex >= 0) state.admin.products[existingIndex] = cachedProduct; else state.admin.products.unshift(cachedProduct);
      try {
        for (const file of files) {
          const upload = await fetch(`/api/admin/products/${saved.id}/images`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file });
          const result = await upload.json().catch(() => ({}));
          if (!upload.ok) throw new Error(result.error || 'No se pudo guardar una imagen.');
          cachedProduct.images.push({ id: result.id, url: result.url, altText: result.altText, position: result.position, isPrimary: result.isPrimary });
          if (result.isPrimary) cachedProduct.imageUrl = result.url;
        }
      } catch (error) {
        state.admin.products = await api('/api/admin/products');
        state.admin.productEdit = state.admin.products.find(item => item.id === saved.id) || saved;
        showToast(`La ficha se guardo; la imagen no se pudo completar: ${error.message}`); render(); return;
      }
      state.admin.productEdit = null; state.admin.productCategory = saved.categoryId || state.admin.productCategory; state.products = await api('/api/catalog'); showToast('Producto guardado.'); render();
    } catch (error) { errorBox.textContent = error.message; errorBox.hidden = false; submitButton.disabled = false; delete form.dataset.saving; }
    }
    return;
  }
  if (form.id === 'admin-filter-form') {
    state.admin.filter = {
      query: String(data.get('query') || '').trim(), status: String(data.get('status') || ''), date: String(data.get('date') || ''),
    };
    render(); return;
  }
  if (form.dataset.adminForm === 'freight') {
    try {
      const updatedOrder = await api(`/api/admin/orders/${form.dataset.orderId}/freight`, { method: 'PUT', body: {
        freight: data.get('freight'), carrier: data.get('carrier'), shipmentTracking: data.get('shipmentTracking'),
      } });
      const orderIndex = state.admin.orders.findIndex(order => order.id === updatedOrder.id); if (orderIndex >= 0) state.admin.orders[orderIndex] = updatedOrder;
      showToast('Flete guardado. El pedido aparece como pendiente de aceptación.'); render();
    } catch (error) { showToast(error.message); }
    return;
  }
  if (form.dataset.adminForm === 'order-status') {
    try {
      const updatedOrder = await api(`/api/admin/orders/${form.dataset.orderId}/status`, { method: 'PUT', body: { status: data.get('status') } });
      const orderIndex = state.admin.orders.findIndex(order => order.id === updatedOrder.id); if (orderIndex >= 0) state.admin.orders[orderIndex] = updatedOrder;
      showToast('Estado del pedido actualizado.'); render();
    } catch (error) { showToast(error.message); }
    return;
  }
  if (form.dataset.adminForm === 'quote-status') {
    try {
      const updatedQuote = await api(`/api/admin/quotes/${form.dataset.quoteId}/status`, { method: 'PUT', body: { status: data.get('status') } });
      const quote = state.admin.quotes.find(item => item.id === updatedQuote.id); if (quote) quote.status = updatedQuote.status;
      showToast('Estado de la solicitud actualizado.'); render();
    } catch (error) { showToast(error.message); }
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button) { event.preventDefault(); handleAction(button); }
});

document.addEventListener('submit', event => {
  const form = event.target;
  if (form.matches('#quote-form, #checkout-form, #manual-track-form, #admin-login-form, #admin-product-form, #admin-filter-form, [data-admin-form]')) {
    event.preventDefault(); handleSubmit(form);
  }
});

document.addEventListener('change', event => {
  const imageInput = event.target.closest('[data-product-images]');
  if (imageInput) {
    for (const url of (state.admin.previewUrls || [])) URL.revokeObjectURL(url);
    state.admin.previewUrls = [];
    const preview = document.querySelector('[data-selected-preview]'); preview?.replaceChildren();
    for (const file of [...imageInput.files]) {
      const url = URL.createObjectURL(file); state.admin.previewUrls.push(url);
      const image = document.createElement('img'); image.src = url; image.alt = file.name; image.loading = 'lazy';
      preview?.append(image);
    }
    return;
  }
  const productCategory = event.target.closest('[data-product-category]');
  if (productCategory) { state.admin.productCategory = productCategory.value; render(); return; }
  const productVisibility = event.target.closest('[data-product-visibility]');
  if (productVisibility) { state.admin.productVisibility = productVisibility.value; render(); return; }
  const formCategory = event.target.closest('#admin-product-category');
  if (formCategory) {
    const category = state.admin.categories.find(item => item.id === formCategory.value);
    const select = document.querySelector('#admin-product-subcategory');
    if (select) select.innerHTML = `<option value="">Sin subcategoría</option>${(category?.subcategories || []).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('')}`;
    const add = formCategory.closest('.field')?.parentElement?.querySelector('[data-action="add-subcategory"]');
    if (add) add.disabled = !category;
    return;
  }
  const quantityInput = event.target.closest('[data-cart-qty]');
  if (quantityInput) {
    const amount = Number(quantityInput.value);
    if (!Number.isInteger(amount) || amount < 1 || amount > 9999) return showToast('La cantidad debe ser un entero entre 1 y 9999.');
    state.cart[quantityInput.dataset.cartQty] = amount; saveCart(); render();
    return;
  }
  const select = event.target.closest('[data-quote-select]');
  if (select) {
    const input = select.closest('.field').querySelector('[name="productName"]');
    const custom = select.value === 'custom';
    input.hidden = !custom;
    input.required = custom;
    if (!custom) input.value = '';
  }
});

document.addEventListener('dragover', event => {
  if (event.target.closest('[data-image-drop]')) event.preventDefault();
});
document.addEventListener('drop', event => {
  const area = event.target.closest('[data-image-drop]'); if (!area) return;
  event.preventDefault();
  const input = area.querySelector('[data-product-images]');
  if (input && event.dataTransfer?.files?.length) { input.files = event.dataTransfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); }
});

window.addEventListener('hashchange', render);
window.addEventListener('popstate', render);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.admin.routeActive && Date.now() - state.admin.validatedAt > adminSessionMaxAgeMs) render();
});
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const [config, products] = await Promise.all([api('/api/config'), api('/api/catalog')]);
    state.config = config;
    state.products = products;
  } catch (error) { showToast(error.message); }
  render();
});

