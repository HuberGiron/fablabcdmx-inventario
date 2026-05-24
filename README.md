# FabLab Inventario · versión mínima online

Esta carpeta contiene una versión estática lista para publicar en Nginx.

## Qué incluye

- `public/`: frontend listo para subir a `/var/www/fablab-inventario`.
- `firebase/firestore.rules`: reglas Firestore que debes publicar desde Firebase Console.
- `deploy/nginx-fablab-inventario.conf`: configuración base de Nginx.

## Qué está activo

- Login con Firebase Authentication.
- Catálogo `index.html`.
- Vista admin con edición rápida de items y áreas.
- Creación/edición de items y ubicaciones desde Firebase/Firestore.
- Desactivar y eliminar items desde la vista admin.

## Qué queda deshabilitado en esta versión mínima

- Backend FastAPI.
- Carga de imágenes, PDFs y fichas técnicas.
- Importación masiva desde el panel.
- Creación de técnicos desde el panel.
- Procesamiento técnico de préstamos desde backend.

## Seguridad

El archivo `public/js/firebase-config.js` no es una llave privada. Es la configuración pública que necesita el navegador para conectarse a Firebase.

No se incluye ningún archivo secreto. No subas jamás:

- `firebase-service-account.json`
- `.env`
- `secrets/`
- `backend/.env`

La seguridad real está en Firebase Authentication, las reglas de Firestore y los roles guardados en `users/{uid}`.

## Publicación rápida

En el Droplet:

```bash
sudo mkdir -p /var/www/fablab-inventario
sudo chown -R $USER:www-data /var/www/fablab-inventario
```

Desde tu computadora, dentro de esta carpeta descomprimida:

```powershell
scp -r .\public\* huber@IP_DE_TU_DROPLET:/var/www/fablab-inventario/
```

En el Droplet:

```bash
sudo nano /etc/nginx/sites-available/fablab-inventario
```

Pega el contenido de `deploy/nginx-fablab-inventario.conf`, ajusta `server_name` si usarás otro dominio, y luego:

```bash
sudo ln -s /etc/nginx/sites-available/fablab-inventario /etc/nginx/sites-enabled/fablab-inventario
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d inventario.mecatronica-ibero.mx
```

En Firebase Console agrega el dominio en:

Authentication → Settings → Authorized domains

Ejemplo:

```text
inventario.mecatronica-ibero.mx
```

## Publicar reglas

Copia el contenido de:

```text
firebase/firestore.rules
```

y publícalo en:

Firestore Database → Rules
