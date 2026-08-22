# CF ActivityPub

[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Versión](https://img.shields.io/github/v/tag/manalejandro/cf-activitypub-next?label=versión)](https://github.com/manalejandro/cf-activitypub-next/releases)
[![PRs bienvenidos](https://img.shields.io/badge/PRs-bienvenidos-brightgreen.svg)](https://github.com/manalejandro/cf-activitypub-next/pulls)

> Un servidor ActivityPub compatible con Mastodon construido para el edge — impulsado por Cloudflare Workers, D1 y la web abierta.

## Visión general

**CF ActivityPub** es un servidor social completamente funcional que implementa el protocolo [ActivityPub](https://www.w3.org/TR/activitypub/) con compatibilidad con la [API REST de Mastodon](https://docs.joinmastodon.org/api/). Funciona enteramente sobre [Cloudflare Workers](https://workers.cloudflare.com/) — sin servidores tradicionales, sin Docker.

- **Sin cold starts** — el modelo de V8 isolates de Cloudflare arranca al instante en más de 300 ubicaciones
- **Compatible con clientes Mastodon** — funciona con Ivory, Elk, Tusky, Megalodon y cualquier app Mastodon
- **Federado** — sigue, impulsa, gusta y menciona a través del fediverso
- **Criptográficamente seguro** — HTTP Signatures vía Web Crypto API
- **Notificaciones Web Push** — notificaciones nativas a móvil/escritorio vía VAPID + AES-128-GCM
- **Potenciado por IA** — texto alternativo automático para imágenes vía Workers AI (LLaVA)
- **Moderación con IA (Guardian)** — un moderador totalmente autónomo mantiene la instancia a salvo de spam y toxicidad, con un registro de auditoría completo
- **Código abierto** — licencia MIT

## Arquitectura

| Capa | Tecnología |
|---|---|
| Runtime | Cloudflare Workers |
| Framework | Next.js 16 App Router via @opennextjs/cloudflare |
| Base de datos | Cloudflare D1 (SQLite) |
| Caché / Sesiones | Cloudflare KV |
| Almacenamiento multimedia | Cloudflare R2 |
| Entrega asíncrona | Cloudflare Queues |
| Streaming en tiempo real | Cloudflare Durable Objects (TimelineStreamDO) |
| Señalización WebRTC | Cloudflare Durable Objects (CallSignalingDO) |
| ICE WebRTC | STUN de Cloudflare + TURN opcional de Cloudflare Calls |
| Inferencia IA | Cloudflare Workers AI (LLaVA para descripciones multimedia; Llama Guard + Llama 3.3 + embeddings BGE-M3 para moderación) |
| Memoria semántica | Cloudflare Vectorize (memoria de abuso de moderación + precedente RAG) |
| Correo electrónico | Cloudflare Email Workers (vía binding `send_email`) |
| Criptografía | Web Crypto API (RSASSA-PKCS1-v1_5 + PBKDF2 + ECDH + AES-128-GCM) |
| Estilos | Tailwind CSS v4 |

## Variables de entorno

### Secretos (`wrangler secret put`)

```bash
# Cloudflare Turnstile (protección contra bots en el registro)
wrangler secret put TURNSTILE_SECRET

# Cloudflare Calls TURN (opcional — relevo WebRTC detrás de NAT simétrico)
wrangler secret put CALLS_TURN_KEY_ID
wrangler secret put CALLS_API_TOKEN

# Clave privada VAPID para Web Push (generar con el script)
wrangler secret put VAPID_PRIVATE_KEY

# Token de la API de administración (opcional — si se define, los endpoints admin requieren Bearer)
wrangler secret put ADMIN_TOKEN
```

### Generación de claves VAPID

Las notificaciones Web Push requieren un par de claves VAPID. Genera una con:

```bash
node scripts/generate-vapid-keys.mjs
```

Esto imprime `VAPID_PUBLIC_KEY` (seguro en `wrangler.toml` bajo `[vars]`) y `VAPID_PRIVATE_KEY` (debe ser secreto). Define `VAPID_EMAIL` como `mailto:admin@tudominio.com`.

### Generación del token de administración

La API de administración del Guardian se protege con un secreto compartido cuando se define `ADMIN_TOKEN`. Genera un token aleatorio fuerte con:

```bash
openssl rand -hex 64
```

Luego configúralo como secreto de Cloudflare:

```bash
wrangler secret put ADMIN_TOKEN
```

Para desarrollo local, ponlo en `.dev.vars` en su lugar:

```
ADMIN_TOKEN=tu-token-generado
```

Cuando está configurado, cada petición a `/api/v1/admin/*` debe enviar `Authorization: Bearer <token>`. Sin él, las rutas admin quedan abiertas (comportamiento por defecto).

### Índice Vectorize (opcional)

La moderación con IA ("Guardian") obtiene una memoria semántica del abuso confirmado vía [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/): los casi-duplicados de spam conocido se bloquean sin una nueva llamada a la IA, y los casos previos similares se muestran al modelo de razonamiento como precedente.

Crea el índice (las dimensiones deben coincidir con el modelo de embeddings `@cf/baai/bge-m3`):

```bash
npx wrangler vectorize create moderation-vectors --dimensions=1024 --metric=cosine
```

Después descomenta el bloque `[[vectorize]]` al inicio de `wrangler.toml`. Sin el binding, la moderación sigue funcionando igual — la memoria vectorial simplemente queda desactivada.

### Variables de texto plano (`[vars]` en `wrangler.toml`)

| Variable | Descripción |
|---|---|
| `INSTANCE_URL` | Tu dominio público (ej. `https://social.ejemplo.com`) |
| `INSTANCE_TITLE` | Nombre visible de la instancia |
| `INSTANCE_DESCRIPTION` | Descripción corta de la instancia |
| `INSTANCE_VERSION` | Versión |
| `VAPID_PUBLIC_KEY` | Clave pública VAPID (de `generate-vapid-keys.mjs`) |
| `VAPID_EMAIL` | Correo de contacto VAPID (`mailto:...`) |
| `TURNSTILE_SITE_KEY` | Clave pública de Cloudflare Turnstile |
| `FROM_EMAIL` | Dirección remitente para correos transaccionales (debe pertenecer a un dominio con Email Routing de Cloudflare) |
| `LIBRETRANSLATE_URL` | URL de instancia LibreTranslate (vacío para deshabilitar traducción) |
| `NODE_ENV` | `production` |

## Despliegue

### Requisitos

- Node.js 18+, npm
- Una cuenta de [Cloudflare](https://dash.cloudflare.com)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### 1. Clonar e instalar

```bash
git clone https://github.com/manalejandro/cf-activitypub-next.git
cd cf-activitypub-next
npm install
```

### 2. Crear recursos en Cloudflare

```bash
wrangler login
wrangler d1 create cf-activitypub
wrangler kv namespace create CF_ACTIVITYPUB_KV
wrangler r2 bucket create cf-activitypub-media
wrangler queues create cf-activitypub-delivery
wrangler queues create cf-activitypub-delivery-dlq
```

La cola de entrega (`cf-activitypub-delivery`) distribuye las actividades ActivityPub a los
inboxes remotos. Su consumidor reintenta los fallos transitorios (`max_retries = 5`);
los mensajes que siguen fallando tras todos los reintentos se mueven a la cola de
mensajes muertos `cf-activitypub-delivery-dlq` en lugar de descartarse en silencio. Inspecciona
o reenvía esos mensajes con:

```bash
wrangler queues info cf-activitypub-delivery-dlq
```

Copia los IDs generados en `wrangler.toml`:
- `database_id` bajo `[[d1_databases]]`
- `id` bajo `[[kv_namespaces]]`

### 3. Configurar tu dominio

Edita `wrangler.toml` y define:
- `INSTANCE_URL` — tu dominio público (ej. `https://social.ejemplo.com`)
- `pattern` bajo `[[routes]]` — tu dominio personalizado

### 4. Generar claves VAPID para Web Push

```bash
node scripts/generate-vapid-keys.mjs
```

Añade `VAPID_PUBLIC_KEY` y `VAPID_EMAIL` a `wrangler.toml` en `[vars]`, luego:

```bash
wrangler secret put VAPID_PRIVATE_KEY
```

### 5. Configurar el resto de secretos

```bash
wrangler secret put TURNSTILE_SECRET
```

Opcional — solo si necesitas relevo TURN para llamadas WebRTC:
```bash
wrangler secret put CALLS_TURN_KEY_ID
wrangler secret put CALLS_API_TOKEN
```

Opcional — solo si quieres proteger la API de administración:
```bash
# Genera primero el token: openssl rand -hex 64
wrangler secret put ADMIN_TOKEN
```

### 6. Ejecutar migraciones de base de datos

```bash
npm run db:migrate
```

Para reiniciar la base de datos:
```bash
wrangler d1 execute cf-activitypub --remote --file=lib/db/drop.sql
npm run db:migrate
```

### 7. Desplegar

```bash
npm run deploy
```

### Vista previa local

```bash
npm run preview
```

Ejecuta el runtime de Cloudflare Workers localmente vía `wrangler dev` (usa D1 remoto por defecto).

## Características

### Federación ActivityPub
- Descubrimiento de actores vía WebFinger
- Perfiles de actor, Inbox/Outbox, colecciones de Seguidores/Siguiendo
- Shared inbox para difusión eficiente
- HTTP Signatures en todas las solicitudes federadas
- Maneja: Create, Follow, Accept, Reject, Undo, Like, Announce, Delete, Update
- Soporte NodeInfo

### API Mastodon
- OAuth 2.0 (password + client_credentials)
- Registro de cuentas, gestión de perfil, seguir/dejar de seguir
- Crear/eliminar estados, favoritos, impulsar, encuestas
- Líneas de tiempo principal y públicas, líneas de tiempo por hashtag
- Notificaciones (seguir, mención, favorito, impulso, encuesta, edición)
- Subida de archivos multimedia (respaldado por R2)
- Bloqueos, bloqueos por dominio, solicitudes de seguimiento

### Tiempo real
- Líneas de tiempo en streaming vía Durable Objects

### Notificaciones Web Push
- Push autenticado con VAPID a todos los servicios de push principales (Apple, Google, Mozilla)
- Payloads cifrados con AES-128-GCM
- Gestión del ciclo de vida de suscripciones (limpieza automática en 410/404)
- Se dispara por: seguir, favorito, impulso, mención, resultados de encuesta, ediciones de estado

### Descripciones de imágenes con IA
- Generación automática de texto alternativo vía Cloudflare Workers AI (modelo LLaVA)
- Se activa al subir un archivo multimedia sin descripción

### Moderación con IA (Guardian)
Moderación totalmente autónoma — no hay administrador humano, la IA gestiona la seguridad de la instancia. La instancia es bilingüe (inglés + español); los prompts y los correos de notificación se adaptan al idioma.

- **Resolución automática de reportes** — los reportes de Mastodon entrantes se evalúan y resuelven (dismiss / warn / delete / suspend), notificando el resultado al denunciante
- **Filtrado previo a la publicación** — cada estado nuevo se filtra con Llama Guard; el contenido marcado se eleva a un modelo de razonamiento (allow / mark_sensitive / delete / escalate)
- **Revisión de registros** — los nuevos registros se revisan por si hubiera abuso antes de aprobarse
- **Patrulla de cuentas** — un ciclo programado escanea estados recientes, cuentas sospechosas, spam duplicado y dominios de spam
- **Heurísticas deterministas** — señales basadas en reglas (publicaciones solo con enlaces, abuso de mayúsculas/emojis, palabras clave de estafa en inglés y español, inundaciones de publicaciones, seguimiento masivo) alimentan cada decisión de la IA, de modo que el spam se detecta incluso si el LLM no está disponible
- **Memoria vectorial (Cloudflare Vectorize)** — el abuso confirmado se incrusta y almacena; los casi-duplicados de spam conocido se bloquean al instante sin una nueva llamada a la IA, y los casos previos similares se inyectan en el prompt de decisión como precedente RAG
- **Registro de auditoría completo** — cada decisión se escribe en la tabla `moderation_log` con la acción, el motivo y la confianza
- **Motor de acciones** — las cuentas advertidas / suspendidas / rechazadas (y las publicaciones eliminadas) reciben notificación por correo, y las suspensiones purgan el contenido de la cuenta
- **API de administración** — lee el registro de moderación vía `GET /api/v1/admin/moderation_log`; opcionalmente protegida por `ADMIN_TOKEN` (Bearer)

### Llamadas WebRTC
- Llamadas de voz y vídeo entre usuarios de la misma instancia o entre instancias federadas
- Durable Object `CallSignalingDO` por llamada que retransmite oferta/respuesta SDP y candidatos ICE
- Señalización entre instancias vía ActivityPub (`CallOffer`, `CallAnswer`, `CallIceCandidate`, `CallHangup`)
- Superposición de llamada entrante con aceptar/rechazar, panel de llamada activa con silenciar/cámara/colgar
- Configuración ICE: STUN de Cloudflare (`stun:stun.cloudflare.com:3478`) por defecto; TURN opcional vía API de Cloudflare Calls

#### TURN opcional (Cloudflare Calls)
Para habilitar relevo TURN en usuarios detrás de NAT simétrico:
```bash
wrangler secret put CALLS_TURN_KEY_ID
wrangler secret put CALLS_API_TOKEN
```
Credenciales en [dash.cloudflare.com](https://dash.cloudflare.com) → Realtime → Calls → TURN.

### Tareas programadas
- Trigger cron cada minuto para encuestas, auto-borrado y otras tareas de mantenimiento
- Incluye el ciclo de patrulla del Guardian (barridos de spam/abuso con revisión de IA)

## Descargo de responsabilidad

El autor no se hace responsable del uso de esta instancia ni de los importes que Cloudflare pueda cobrar por su uso.

## Licencia

MIT
