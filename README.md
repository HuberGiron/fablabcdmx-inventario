# FabLab Inventario · catálogo, préstamo y archivos

Esta versión incluye el frontend estático del inventario y un backend FastAPI para subir/servir imágenes y documentación asociada a cada item.

## Cambios principales de esta entrega

- La tarjeta grande de encabezado del catálogo fue eliminada para recuperar espacio vertical.
- La etiqueta de vista (`pública`, `alumno`, `técnico`, `admin`) se movió a la barra de navegación.
- Los filtros del catálogo se reorganizaron:
  - Primer renglón: Zona, Subzona, Ubicación.
  - Segundo renglón: Tipo, FabAcademy.
  - Tercer renglón: Buscar, contador, Limpiar filtros, Exportar Excel filtrado.
- Se eliminó el filtro de Máquina relacionada de la vista principal.
- La exportación visible ahora genera `.xlsx` con las mismas columnas base del reporte administrativo de inventario filtrado.
- Las tarjetas ahora muestran la ruta física de forma más discreta.
- Se eliminó la leyenda repetitiva de vista técnica/admin en cada tarjeta.
- Las tarjetas muestran botones de `Más info` y `Descargar documentación` cuando el item tiene URL o archivo asociado.
- La edición rápida del item permite subir imagen y documentación.
- Se agrega backend FastAPI para almacenar archivos en el Droplet y registrar metadatos en Firestore.

## Estructura

```text
public/                         Frontend estático para Nginx
public/js/catalogo.js            Catálogo principal, filtros, tarjetas, exportación XLSX y edición rápida
public/js/common.js              Navegación, API fetch, vista/descarga/subida de archivos
backend/                         API FastAPI para imágenes y documentos
deploy/nginx-fablab-inventario.conf
                                Nginx para el frontend
deploy/nginx-inventario-api.conf Nginx para el subdominio del backend
deploy/inventario-api.service    Servicio systemd para FastAPI
firebase/firestore.rules         Reglas Firestore
```

## Campos nuevos recomendados en `items`

Tu estructura base de item se mantiene. A esa estructura se agregan campos opcionales para archivos:

```json
{
  "infoUrl": "https://...",
  "imageFileId": "...",
  "imageFilename": "foto.jpg",
  "imageMimeType": "image/jpeg",
  "imageSizeBytes": 12345,
  "documentationFileId": "...",
  "documentationFilename": "manual.pdf",
  "documentationMimeType": "application/pdf",
  "documentationSizeBytes": 12345,
  "pdfFileId": "...",
  "pdfFilename": "manual.pdf"
}
```

`pdfFileId` y `pdfFilename` se conservan como compatibilidad con vistas anteriores; el campo nuevo principal es `documentationFileId`.

## Publicación del frontend

En el Droplet:

```bash
sudo mkdir -p /var/www/fablab-inventario
sudo chown -R $USER:www-data /var/www/fablab-inventario
```

Desde tu computadora, dentro de esta carpeta:

```powershell
scp -r .\public\* huber@IP_DE_TU_DROPLET:/var/www/fablab-inventario/
```

En el Droplet:

```bash
sudo nano /etc/nginx/sites-available/fablab-inventario
```

Pega `deploy/nginx-fablab-inventario.conf`, ajusta el dominio si hace falta y ejecuta:

```bash
sudo ln -s /etc/nginx/sites-available/fablab-inventario /etc/nginx/sites-enabled/fablab-inventario
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d inventario.mecatronica-ibero.mx
```

## Publicación del backend en DigitalOcean

### 1. Crear carpetas

```bash
sudo mkdir -p /opt/fablab-inventario/backend
sudo mkdir -p /var/www/fablab-inventario-files
sudo mkdir -p /etc/fablab-inventario
sudo chown -R www-data:www-data /var/www/fablab-inventario-files
```

Sube la carpeta `backend/` a:

```text
/opt/fablab-inventario/backend
```

### 2. Crear entorno Python

```bash
cd /opt/fablab-inventario/backend
sudo python3 -m venv .venv
sudo .venv/bin/pip install --upgrade pip
sudo .venv/bin/pip install -r requirements.txt
sudo chown -R www-data:www-data /opt/fablab-inventario/backend
```

### 3. Agregar credencial Firebase Admin

Descarga desde Firebase Console un service account JSON y súbelo a:

```text
/etc/fablab-inventario/firebase-service-account.json
```

Protege el archivo:

```bash
sudo chown root:www-data /etc/fablab-inventario/firebase-service-account.json
sudo chmod 640 /etc/fablab-inventario/firebase-service-account.json
```

### 4. Crear variables de entorno

```bash
sudo nano /etc/fablab-inventario/api.env
```

Contenido sugerido:

```env
PROJECT_NAME="FabLab Inventario API"
GOOGLE_APPLICATION_CREDENTIALS="/etc/fablab-inventario/firebase-service-account.json"
UPLOAD_ROOT="/var/www/fablab-inventario-files"
CORS_ORIGINS="https://inventario.mecatronica-ibero.mx"
MAX_IMAGE_BYTES=8388608
MAX_DOCUMENT_BYTES=26214400
```

### 5. Activar servicio systemd

```bash
sudo cp deploy/inventario-api.service /etc/systemd/system/inventario-api.service
sudo systemctl daemon-reload
sudo systemctl enable inventario-api
sudo systemctl start inventario-api
sudo systemctl status inventario-api
```

### 6. Activar Nginx del API

```bash
sudo nano /etc/nginx/sites-available/inventario-api
```

Pega `deploy/nginx-inventario-api.conf` y luego:

```bash
sudo ln -s /etc/nginx/sites-available/inventario-api /etc/nginx/sites-enabled/inventario-api
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d inventario-api.mecatronica-ibero.mx
```

Prueba:

```bash
curl https://inventario-api.mecatronica-ibero.mx/api/health
```

Debe responder algo parecido a:

```json
{"status":"ok","service":"FabLab Inventario API"}
```

## Configuración del frontend para el API

En `public/js/firebase-config.js` quedó configurado:

```js
export const API_BASE_URL = "https://inventario-api.mecatronica-ibero.mx";
```

Si usas otro subdominio, cambia ese valor antes de subir el frontend.

## Seguridad

No subas jamás al repositorio ni al frontend:

- `firebase-service-account.json`
- `.env`
- `api.env`
- `secrets/`

El navegador usa Firebase Auth para obtener el token del usuario. El backend valida ese token y solo permite subir archivos a usuarios con `role: admin` en `users/{uid}`.
