# DAYBREAKER SAS · Base comercial

Maqueta funcional de una plataforma comercial con catálogo minorista, pedidos con flete a cotizar y solicitudes mayoristas separadas. La aplicación usa Node.js y SQLite sin dependencias externas.

## Requisitos y puesta en marcha

- Node.js 22.13 o superior.
- En PowerShell, copiá `.env.example` como `.env` y completá `ADMIN_PASSWORD` con una clave única de al menos 16 caracteres.
- Ejecutá `npm.cmd start` y abrí `http://localhost:3000`.

No hace falta instalar paquetes npm. La base SQLite se crea en `data/daybreaker.sqlite` al iniciar. El catálogo empieza vacío para evitar inventar productos o precios.

## Publicación de vista previa en Vercel

El repositorio incluye `vercel.json` y una función Node.js para publicar la web. Importá el repositorio `Daybreaker_SaaS_Pagina_Web` en Vercel; usá Node.js 24 y dejá vacíos el comando de compilación y el directorio de salida.

La publicación queda en modo de solo lectura: Vercel ejecuta funciones con sistema de archivos efímero y la base SQLite local no sirve para guardar pedidos de forma persistente. La vista pública puede recorrerse, pero los cambios y formularios que guardan datos responden con un aviso hasta conectar una base persistente. No habilites operaciones reales ni pagos en esta vista previa.

Para habilitar operaciones en producción, primero hay que conectar una base de datos persistente y adaptar el acceso de datos; luego se configuran en Vercel `ADMIN_PASSWORD`, `PUBLIC_BASE_URL`, los datos comerciales autorizados y, si corresponde, las credenciales de Mercado Pago. La documentación de Vercel describe el sistema de archivos de sus funciones como de solo lectura, con `/tmp` temporal, y ofrece bases de datos mediante integraciones de Marketplace.

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
