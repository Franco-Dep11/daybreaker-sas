# DAYBREAKER S.A.S.

Aplicación comercial para catálogo minorista, pedidos con flete cotizado, presupuestos mayoristas y panel administrativo. El frontend y la API Node.js se alojan en Vercel; la API de D1 se autentica servidor a servidor ante un Cloudflare Worker con secreto compartido y el Worker accede a D1 y R2 con bindings nativos. La lectura de imágenes es pública; el navegador nunca recibe el secreto del Worker.

## Estado actual

- La rama `feature/cloudflare-d1` alimenta Vercel Preview. El commit `f0f1f585` agregó renderizado público indexable, metadatos, sitemap, `noindex` para Preview y analítica GA4 optativa.
- El entorno Cloudflare de desarrollo existente es `daybreaker-d1-dev`, base `daybreaker-sas-dev` y bucket `daybreaker-product-images`; Wrangler está configurado para esos recursos en `wrangler.toml`.
- Production ya tiene D1 `daybreaker-sas-prod` con las migraciones `0001`–`0004` aplicadas, bucket `daybreaker-product-images-prod` vacío y Worker `daybreaker-d1-prod` desplegado. La configuración independiente está en el archivo local `wrangler.production.toml` (no versionarlo).
- El Worker Production aún no tiene `D1_API_SECRET`: su API responde cerrado hasta configurarlo. Vercel CLI está sin sesión y no hay un proyecto vinculado localmente; no pude revisar ni modificar variables o deployments Production.
- La D1 Production está sin registros de catálogo ni operaciones. La inspección de desarrollo encontró cero categorías, cero subcategorías y un único producto de prueba (`producto-de-prueba-d1`) con una imagen. No se trasladó: el brief requiere detenerse ante datos de prueba y consultar antes de importar.
- Los pagos permanecen desactivados si no se configuran variables bancarias ni credenciales de Mercado Pago. Para este primer lanzamiento, dejalas sin configurar.
- Los presupuestos se gestionan manualmente desde el panel. El sitio no envía avisos por email ni WhatsApp automáticamente.

## Desarrollo y pruebas

Se requiere Node.js 24.x. La app local usa SQLite y no necesita paquetes npm para ejecutarse:

```powershell
Copy-Item .env.example .env
npm.cmd start
```

Configurá una clave local `ADMIN_PASSWORD` de al menos 16 caracteres antes de usar el panel. `.env`, `.dev.vars`, bases locales, copias de seguridad y cachés de herramientas no deben versionarse.

```powershell
npm.cmd test
npm.cmd run verify:d1
```

`verify:d1` requiere `D1_PROXY_URL` y `D1_PROXY_SECRET` en el entorno local; solo verifica una consulta autenticada. No cambies `.env` de desarrollo para conectarlo accidentalmente a producción.

## Cloudflare Production

Ya existen `daybreaker-sas-prod`, `daybreaker-product-images-prod` y `daybreaker-d1-prod`; no vuelvas a crearlos. Se confirmó que D1 estaba vacía antes de migrar. Wrangler aplicó `0001`–`0004`; la lista remota no muestra pendientes y las tablas/índices esperados están presentes. Los conteos comerciales siguen en cero. El respaldo de esquema anterior a la importación está en `backups/daybreaker-sas-prod-before-catalog-2026-11-17.sql` y es local/ignorado.

El Worker se desplegó con bindings `DB` y `ASSETS`. La verificación de compilación en seco pasó. No hay secretos configurados y no se verificó todavía una consulta autenticada Worker→D1. La comprobación `PRAGMA foreign_key_check` no devolvió filas; Cloudflare rechazó `PRAGMA integrity_check` con `SQLITE_AUTH`, por lo que esa comprobación no pudo completarse directamente.

La intervención de secreto es necesaria. Generá una clave aleatoria nueva de al menos 32 bytes y cargá el mismo valor de forma privada en el secreto del Worker y en Vercel Production. No lo pongas en TOML, Git, una orden visible ni el chat. En una terminal segura:

   ```powershell
   npx wrangler --config wrangler.production.toml secret put D1_API_SECRET
   ```

El secreto de Production debe ser distinto al de desarrollo. `wrangler secret list --name daybreaker-d1-prod` muestra solo los nombres y actualmente devuelve una lista vacía. Después de cargar el secreto, verificar el endpoint con `npm.cmd run verify:d1` en un entorno controlado y añadir `D1_PROXY_VERIFIED=true` en Vercel solo cuando la verificación pase. El endpoint Vercel de verificación no está configurado en este equipo.

## Trasladar el catálogo y las imágenes de desarrollo

El traslado es una operación manual, no ejecutada. Exportá solamente `categories`, `subcategories`, `products` y `product_images`; no exportes `orders`, `order_items`, `quotes`, `payments`, `admin_sessions` ni `order_events`. Así no se trasladan pedidos de prueba, contactos, pagos ni sesiones. Los `INSERT` exportados conservan IDs y claves foráneas.

**Estado de esta ejecución:** la fuente tenía 0 categorías, 0 subcategorías, 1 producto identificado como `Producto de prueba D1` (descripción “Prueba de persistencia Cloudflare D1”) y 1 imagen en R2. Se detuvo la importación y no se copió la imagen porque no es un artículo comercial real. Confirmar/cargar los productos reales en desarrollo antes de repetir el traslado.

1. Creá una carpeta de trabajo con acceso restringido **fuera del repositorio** y guardá allí las exportaciones. Primero congelá cambios al catálogo de desarrollo. Exportá cada tabla, sin esquema, usando Wrangler autenticado:

   ```powershell
   $work = Join-Path $env:TEMP 'daybreaker-catalog-transfer'
   New-Item -ItemType Directory -Force $work | Out-Null
   npx wrangler d1 export daybreaker-sas-dev --remote --table=categories --no-schema --output="$work\01-categories.sql"
   npx wrangler d1 export daybreaker-sas-dev --remote --table=subcategories --no-schema --output="$work\02-subcategories.sql"
   npx wrangler d1 export daybreaker-sas-dev --remote --table=products --no-schema --output="$work\03-products.sql"
   npx wrangler d1 export daybreaker-sas-dev --remote --table=product_images --no-schema --output="$work\04-product-images.sql"
   ```

   Antes de cambiar esquema o importar, hacé también un respaldo completo de la base objetivo, incluso si esperás que esté vacía:

   ```powershell
   npx wrangler d1 export daybreaker-sas-prod --remote --output="$work\production-before-transfer.sql"
   ```

2. Verificá en producción que las cuatro tablas objetivo estén vacías. Si alguna contiene filas, **detenete**: no ejecutes los `INSERT` ni sobrescribas nada; primero se necesita una conciliación manual de IDs y slugs.
3. Para cada `object_key` no nulo de `product_images`, descargá el objeto del bucket de desarrollo y cargalo en el bucket de producción bajo la misma clave. Wrangler trabaja un objeto por comando; los archivos de este sitio tienen un límite de 4 MB:

   ```powershell
   $key = 'products/<product-uuid>/<image-uuid>.jpg' # repetí usando cada object_key obtenido de D1
   npx wrangler r2 object get "daybreaker-product-images/$key" --file="$work\image.jpg"
   npx wrangler r2 object put "daybreaker-product-images-prod/$key" --file="$work\image.jpg" --content-type=image/jpeg
   ```

   Elegí `image/png` o `image/webp` según la extensión real. No subas sobre una clave existente: comprobá primero que el bucket nuevo esté vacío. Repetí para todas las claves, incluidas imágenes inactivas referenciadas por filas existentes.
4. En los cuatro SQL exportados, reemplazá el origen del Worker de desarrollo por la URL `workers.dev` que Cloudflare asignó al Worker Production, conservando `/assets/<object_key>`. Esto actualiza las URLs guardadas de R2 sin cambiar las claves de objeto. Revisá también cualquier URL externa de imagen/PDF para conservarla tal cual.
5. Importá en este orden, solo tras confirmar que la base y bucket son los de Production y que las tablas están vacías:

   ```powershell
   npx wrangler --config wrangler.production.toml d1 execute daybreaker-sas-prod --remote --file="$work\01-categories.sql"
   npx wrangler --config wrangler.production.toml d1 execute daybreaker-sas-prod --remote --file="$work\02-subcategories.sql"
   npx wrangler --config wrangler.production.toml d1 execute daybreaker-sas-prod --remote --file="$work\03-products.sql"
   npx wrangler --config wrangler.production.toml d1 execute daybreaker-sas-prod --remote --file="$work\04-product-images.sql"
   ```

6. Compará las cantidades de las cuatro tablas entre origen y destino; ejecutá `PRAGMA foreign_key_check;`; probá las URLs de imagen desde el Worker Production y revisá categorías, subcategorías, precios y fichas en Preview conectado al Worker Production. No borres ni limpies la fuente de desarrollo.
7. Conservá los SQL de transferencia en un almacenamiento privado hasta terminar la validación; después eliminá esa carpeta de trabajo con el procedimiento seguro de DAYBREAKER. No la copies a `backups/` ni la agregues a Git.

La exportación SQL de una D1 puede bloquear consultas mientras corre. Hacela en una ventana coordinada y no ejecutes esta operación durante actividad comercial. Wrangler exporta datos; R2 requiere la copia separada de objetos descrita arriba. [Documentación D1 de exportación e importación](https://developers.cloudflare.com/d1/best-practices/import-export-data/) y [comandos Wrangler de R2](https://developers.cloudflare.com/workers/wrangler/commands/r2/).

## Variables de Vercel

En **Settings → Environment Variables**, crear variables diferentes por entorno. Production requiere:

| Variable | Valor / regla |
| --- | --- |
| `D1_PROXY_URL` | URL HTTPS del Worker `daybreaker-d1-prod` |
| `D1_PROXY_SECRET` | El valor del secreto `D1_API_SECRET` de Production; separado de Preview |
| `D1_PROXY_VERIFIED` | `true` solo después de que `npm.cmd run verify:d1` confirme `SELECT 1` autenticado desde una máquina controlada, apuntando al Worker Production |
| `ADMIN_PASSWORD` | Contraseña única, privada, de 16+ caracteres |
| `ADMIN_USER` | Recomendado: usuario elegido; si se omite, el código usa `admin` |
| `PUBLIC_BASE_URL` | Origen HTTPS definitivo, sin path, por ejemplo `https://<dominio-real>` |
| `CONTACT_EMAIL`, `WHATSAPP_PHONE` | Canales comerciales reales aprobados |

No configures `BANK_ACCOUNT_HOLDER`, `BANK_NAME`, `BANK_CBU`, `BANK_ALIAS`, `BANK_CUIT`, `MERCADOPAGO_ACCESS_TOKEN` ni `MERCADOPAGO_WEBHOOK_SECRET` para esta primera etapa. Sin esos valores, el checkout no habilita cobros online. GA4 es optativo: solo después de aprobar privacidad/consentimiento, agregá `GA4_MEASUREMENT_ID` en Production; mantenelo ausente en Preview.

Agregá primero las variables de Preview apuntando **solo** a D1/R2/Worker de desarrollo. Probá todo allí. Las variables nuevas o editadas se aplican al siguiente deployment, por lo que hay que generar un Preview/Production nuevo después de guardarlas ([documentación Vercel](https://vercel.com/docs/environment-variables)). No copies valores de secretos entre entornos salvo que sea intencional; para Worker, la clave debe coincidir solo con su Vercel correspondiente.

## Dominio, SEO y Search Console

1. En Vercel, agregá el dominio aprobado en **Settings → Domains**. Configurá en el proveedor DNS los registros que Vercel indique; no uses valores copiados de otra instalación.
2. En `PUBLIC_BASE_URL`, guardá el origen final HTTPS y generá un nuevo deployment. La web aplica `noindex` en Preview y también en Production mientras falte esa variable.
3. En el dominio real comprobá portada, `/catalogo`, una ficha visible, `/robots.txt` y `/sitemap.xml`. Confirmá status 200, canonical del dominio final y ausencia de `noindex` en páginas públicas. Carrito, pagos, seguimiento y admin deben permanecer en `noindex`.
4. Verificá el dominio raíz en Google Search Console mediante el registro TXT que Google proporciona; luego enviá `https://<dominio-real>/sitemap.xml` e inspeccioná portada, catálogo y una ficha. La propiedad y el sitemap no se han verificado ni enviado.
5. Si GA4 se habilita, desactivá **Medición mejorada → Vistas de página → Cambios de página basados en eventos del historial** porque la SPA ya envía vistas manualmente. No cargues Analytics hasta obtener aprobación del texto de consentimiento.

Más detalles: [verificación DNS de Search Console](https://support.google.com/webmasters/answer/9008080), [propiedades de Search Console](https://support.google.com/webmasters/answer/34592) y [vistas GA4](https://developers.google.com/analytics/devguides/collection/ga4/views?technology=websites).

## Respaldos, recuperación y reversión

- **D1:** antes de migraciones o importaciones, exportá la base remota completa a un archivo fuera del repositorio y cifralo con el mecanismo corporativo. Ejemplo de exportación: `npx wrangler d1 export daybreaker-sas-prod --remote --output="$work\daybreaker-prod.sql"`. Ese archivo incluye datos personales y sesiones hasheadas: limitar acceso, no subirlo a Git ni compartirlo en chat. Verificá la opción de recuperación temporal/Time Travel habilitada en la cuenta y su retención antes de depender de ella. Para restaurar, creá una D1 vacía de recuperación, configurá temporalmente un TOML local con su ID, importá el archivo con `wrangler d1 execute <db-recuperacion> --remote --file=<copia-sql>`, revisá esquema, integridad y conteos y probá con una copia aislada del Worker. Solo tras aprobación cambiá el binding del Worker; no importes sobre la base con tráfico.
- **R2:** registrá las claves con `object_key` desde D1 y descargá/copiá los objetos a una ubicación privada separada. Comprueba conteos y aperturas de muestra antes de eliminar cualquier copia. Las imágenes de producto no se recuperan con la exportación D1.
- **Código:** anota commit, deployment Vercel, versión Worker y migraciones aplicadas. Si falla una publicación, vuelve Vercel al último deployment validado desde Deployments. Para cambios de esquema/datos, no intentes invertir migraciones destructivamente: restaura en recursos aislados, valida y cambia la URL del Worker solo con autorización.
- **Antes de cada cambio:** detenerse ante discrepancias de entorno, respaldar, aplicar una sola etapa, verificar y continuar. No ejecutar operaciones remotas sobre `daybreaker-sas-dev` cuando el objetivo sea Production.

## Seguridad y pendientes de lanzamiento

- El backend valida sesión administrativa en cada ruta `/api/admin/*`; la cookie es `HttpOnly`, `SameSite=Strict` y `Secure` en producción. Nunca se guardan contraseñas en base ni se exponen secretos en el navegador.
- El código también limita intentos de login en memoria por instancia. En Vercel serverless ese límite no es global ni persistente: antes de abrir el panel a Internet, configurá y observá una regla Vercel Firewall de rate limit para `POST /api/admin/login` (por IP; empezar en modo de registro y después activar 429, por ejemplo con un umbral de 8 intentos/10 min). La interfaz del Firewall permite reglas de rate limit y pruebas en tráfico; consultá [WAF Rate Limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting). No se configuró la regla.
- Seguimiento usa token aleatorio privado; el ID de pedido no basta. No enviar enlaces de seguimiento ni datos personales a Analytics.
- El sistema no emite correo automático, facturas ni avisos de WhatsApp; confirmar cómo responder pedidos y presupuestos manualmente.
- Antes de vender: aprobar razón social, contacto, privacidad, términos, cambios/devoluciones, facturación/impuestos, cobertura de flete, operación y tiempos de respuesta. No inventar promesas de stock, entrega ni cobertura.
- Validar compra, aceptación de flete, estado de pago deshabilitado, seguimiento, categorías e imágenes desde Preview conectado a desarrollo. Luego hacer una prueba de extremo a extremo controlada en Production **sin cobro real** antes de anunciar la tienda.

## Limpieza local

Las bases SQLite de `data/`, sus archivos WAL/SHM, todo `backups/`, `.env`, `.dev.vars`, `.git` y el proyecto local `bakugan-battle-brawlers-enhanced/` son datos o trabajo preservado. No se borran como caché. El archivo local principal puede no representar D1; para productos reales, la fuente indicada es `daybreaker-sas-dev`.
