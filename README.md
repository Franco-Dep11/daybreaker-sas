# DAYBREAKER SAS · Base comercial

Maqueta funcional de una plataforma comercial con catálogo minorista, pedidos con flete a cotizar y solicitudes mayoristas separadas. La aplicación usa Node.js y SQLite sin dependencias externas.

## Requisitos y puesta en marcha

- Node.js 22.13 o superior.
- En PowerShell, copiá `.env.example` como `.env` y completá `ADMIN_PASSWORD` con una clave única de al menos 16 caracteres.
- Ejecutá `npm.cmd start` y abrí `http://localhost:3000`.

No hace falta instalar paquetes npm. La base SQLite se crea en `data/daybreaker.sqlite` al iniciar. El catálogo empieza vacío para evitar inventar productos o precios.

## Publicación de vista previa en Vercel

El repositorio incluye `vercel.json` y una función Node.js para publicar la web. Importá el repositorio `Daybreaker_SaaS_Pagina_Web` en Vercel; usá Node.js 24 y dejá vacíos el comando de compilación y el directorio de salida.

Vercel ejecuta la aplicación y persiste los datos en Cloudflare D1 a través del Worker incluido en `cloudflare/worker.js`. El backend envía identificadores de consultas permitidas y parámetros enlazados; el Worker no acepta SQL arbitrario. Vercel nunca usa SQLite ni `/tmp` como alternativa. El backend de Vercel se niega a iniciar si faltan `D1_PROXY_URL`, `D1_PROXY_SECRET` o `D1_PROXY_VERIFIED=true`.

## Cloudflare D1

La migración inicial está en `migrations/0001_initial.sql` y conserva las siete tablas, claves, restricciones e índices de SQLite. La revisión local encontró cero registros y `PRAGMA integrity_check` devolvió `ok`; por eso no se requiere importar filas existentes y no se sobrescribieron datos. La migración remota debe ejecutarse sólo después de verificar que `daybreaker-sas-dev` es la base correcta.

Para desarrollo del Worker, instalá Wrangler en tu entorno y creá `.dev.vars` a partir de `.dev.vars.example` con un secreto aleatorio privado:

```powershell
Copy-Item .dev.vars.example .dev.vars
npx wrangler d1 migrations apply daybreaker-sas-dev --local
npx wrangler dev
```

La aplicación Node local sigue usando SQLite por defecto. Para probar la aplicación local contra un Worker local, configurá `D1_PROXY_URL=http://127.0.0.1:8787` y el mismo `D1_PROXY_SECRET` en `.env`; quitá esas variables para volver a SQLite.

Antes de migrar, inspeccioná la base remota. Si aparecen tablas de la aplicación o datos que no esperabas, detenete y no apliques la migración:

```powershell
npx wrangler d1 execute daybreaker-sas-dev --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
npx wrangler d1 migrations list daybreaker-sas-dev --remote
```

Después de autenticar Wrangler con tu cuenta Cloudflare y confirmar que no hay tablas/datos que deban conservarse, aplicá la migración y desplegá el Worker:

```powershell
npx wrangler d1 migrations apply daybreaker-sas-dev --remote
npx wrangler deploy
npx wrangler secret put D1_API_SECRET
```

El Worker publicado rechaza toda llamada mientras no tenga el secreto. `wrangler secret put` solicita el valor de forma interactiva y publica la configuración sin tener que pegar el secreto en este repositorio ni en el chat. Generá el mismo secreto de alta entropía localmente para usarlo en Vercel. Poné temporalmente `D1_PROXY_URL` y `D1_PROXY_SECRET` en tu `.env` local y ejecutá `npm.cmd run verify:d1`; el comando sólo envía una comprobación autenticada `SELECT 1`. En el proyecto de Vercel, agregá como variables de entorno para Production (y Preview si corresponde):

- `D1_PROXY_URL`: URL HTTPS del Worker desplegado.
- `D1_PROXY_SECRET`: el secreto compartido, cargado directamente en el panel de Vercel.
- `D1_PROXY_VERIFIED`: el texto `true`, sólo después de que `npm.cmd run verify:d1` haya pasado.
- Conservá `ADMIN_PASSWORD`, `PUBLIC_BASE_URL` y las demás variables comerciales ya aprobadas.

No actives tráfico de producción hasta que el Worker esté desplegado, la migración remota figure aplicada, la verificación de conexión sea correcta y se haya redeplegado Vercel con las tres variables. No se configuran cobros reales durante esta migración.

## Flujos incluidos

- Menú público con Inicio, Quiénes somos, Catálogo, Presupuestos mayoristas, Carrito y seguimiento, y Contacto.
- Fichas de producto con URLs legibles, metadatos y páginas en el sitemap.
- Precios en pesos guardados como centavos; el servidor recalcula los importes desde los precios vigentes y guarda una copia del nombre, precio y cantidad en cada pedido.
- Compra sin registro. El envío se solicita antes del pago; el panel registra el flete y el cliente debe aceptar el total final.
- Seguimiento con un enlace que contiene un token aleatorio en el fragmento privado de la URL. El código de pedido por sí solo no permite consultar información.
- Cotizaciones mayoristas en una tabla y flujo separados de los pedidos minoristas.
- Panel con acceso de servidor, productos editables, archivo lógico del producto, gestión de pedidos, pagos y cotizaciones.
- Transferencia bancaria con estado pendiente hasta que un administrador verifique la acreditación.
- Mercado Pago preparado con creación de preferencia en servidor solo después de aceptar el flete. El retorno del navegador no confirma el pago: el webhook debe ser válido y el servidor vuelve a consultar a Mercado Pago para revisar estado, referencia, moneda e importe.

## Configuración operativa pendiente

Los datos siguientes deben ser provistos o aprobados por DAYBREAKER antes de habilitarse:

- Productos, precios vigentes, disponibilidad, especificaciones, imágenes y fichas PDF.
- `PUBLIC_BASE_URL` con dominio definitivo y HTTPS para publicación.
- Titularidad, CBU, banco y alias en las variables `BANK_*`.
- Credenciales de la cuenta de Mercado Pago en `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_WEBHOOK_SECRET`.
- Email y número de WhatsApp comercial autorizados en `CONTACT_EMAIL` y `WHATSAPP_PHONE`.
- Servicio de email para alertas automáticas, dominio/DNS, Search Console y textos legales aprobados.
- Reglas para emitir y vencer cotizaciones de flete; facturación, impuestos, privacidad, cambios y devoluciones.
- Hosting con almacenamiento persistente para SQLite, HTTPS, restauración de copias y administración bajo control de DAYBREAKER.

La maqueta no envía avisos automáticos por email ni automatiza WhatsApp porque aún no se definieron un proveedor de mensajería ni sus credenciales. El panel conserva las solicitudes; permite responder presupuestos por email o WhatsApp manual cuando esos datos están configurados.

## Copias de seguridad

Con la aplicación detenida o desde otra terminal del mismo proyecto, ejecutá `npm.cmd run backup`. El script usa la copia consistente de SQLite y guarda un archivo fechado en `backups/`.

Para restaurar: detené el servidor, conservá aparte la base actual, copiá el archivo elegido a `data/daybreaker.sqlite` y reiniciá. Antes de publicar se debe definir dónde guardar una segunda copia fuera del servidor y quién verifica periódicamente la restauración.

## Antes de publicar

Esta base sirve para revisar el flujo y completar datos. La instalación de producción necesita dominio y HTTPS, gestión de credenciales en el alojamiento, política de copias externa, cuenta administrativa individual para cada responsable, notificaciones de email configuradas y probadas, datos legales aprobados y validación integral de pagos y operaciones con cuentas de prueba. No habilites cobros hasta configurar y verificar Mercado Pago, transferencia y reglas de flete con DAYBREAKER.

Las cuentas y dominios deben quedar bajo titularidad o control de DAYBREAKER. Código, base y documentación están en el proyecto para facilitar la migración.

## Catalogo administrativo y almacenamiento de imagenes

La migracion aditiva `migrations/0002_admin_catalog.sql` agrega categorias, subcategorias, stock informativo, visibilidad independiente del archivado, atributos flexibles y hasta seis registros de imagen por producto. Tambien copia los valores existentes de `image_url` a la tabla de imagenes sin borrar la columna original ni reemplazar registros.

No se ejecuto ninguna migracion remota ni se desplego el Worker. Cuando autorices el cambio remoto, el orden es: aplicar `0002` sobre D1; crear el bucket R2; agregar el binding al `wrangler.toml`; desplegar el Worker actualizado; y luego publicar la rama en Vercel Preview. No despliegues el backend actualizado antes de la migracion y del Worker porque consulta columnas y operaciones que aun no existen en el esquema desplegado.

Para habilitar cargas, crea un bucket privado desde Cloudflare R2 (por ejemplo `daybreaker-product-images`) y agrega al `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "ASSETS"
bucket_name = "daybreaker-product-images"
```

Despues despliega el Worker desde esta rama y conserva `D1_API_SECRET` configurado como secreto. No se necesita una clave R2 adicional: el Worker accede al bucket mediante el binding nativo. Las cargas se autentican desde la sesion administrativa de Vercel y el Worker verifica el secreto servidor a servidor; el navegador no recibe el secreto. Se aceptan JPEG, PNG y WebP de hasta 4 MB cada uno. Los objetos se sirven publicamente por URL para que las fichas comerciales los muestren; el bucket no permite listado publico.

La interfaz permite asociar URL HTTPS existentes aun antes de configurar R2. Las cargas de archivos responden con error explicito hasta que exista el binding. En desarrollo SQLite, productos, categorias y metadatos persisten localmente; las cargas requieren que el Worker y R2 esten configurados.
En tu equipo, luego de decidir habilitarlo, crea el bucket con `npx wrangler r2 bucket create daybreaker-product-images` y agrega el binding `ASSETS` indicado arriba. Para D1 ejecuta `npx wrangler d1 migrations apply daybreaker-sas-dev --remote`; despues de crear el binding y revisar el diff, despliega el Worker con `npx wrangler deploy`. Por ultimo, publica esta rama en Vercel Preview. No ejecutes los comandos remotos hasta autorizar ese cambio.
