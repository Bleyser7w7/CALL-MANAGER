# Callback Manager

Aplicación web de gestión de devoluciones de llamada con Supabase Auth, PostgreSQL, RLS, Realtime y Edge Functions. La interfaz se sirve como archivos estáticos y mantiene el tema oscuro en todas las pantallas.

## Instancia enlazada

Este workspace está enlazado al proyecto Supabase `pyxxwjkiecdpqvhjxglz`. Su esquema y políticas ya se instalaron, las Edge Functions se desplegaron y el cron `callback-manager-process-alerts` está activo. La URL y la clave pública están configuradas en `js/config.js`.

GitHub Pages está publicado. Para usar la dirección gratuita de GitHub Pages en vez de `call-manager.me`, elimina el dominio personalizado de **Settings → Pages** y configura esa dirección gratuita como URL de autenticación en Supabase (ver los pasos 9 y 10). También falta crear el primer usuario en **Authentication → Users** y promoverlo a administrador (ver el paso 7 de Configuración).

## Funcionalidad incluida

- Inicio/cierre de sesión, recuperación de contraseña y vistas protegidas por rol.
- Pie de página con el aviso `© Bleyser7w7 (2026). All rights reserved`.
- Rol Calidad de solo lectura para revisar callbacks, asignaciones, intentos e informes, sin permisos para crear, asignar o cerrar casos.
- Registro de inicio, actividad y salida de sesión por usuario; administración y supervisión pueden consultar las últimas 100 sesiones desde **Equipo**.
- Inicio de sesión con usuario único; el correo se conserva para recuperar la contraseña y recibir comunicaciones de la cuenta.
- Registro de callbacks con responsable, programación, prioridad y datos del cliente.
- Asignación manual o automática con carga equilibrada; el servidor solo asigna a agentes en turno, marcados como Disponibles y fuera de pausas programadas. Sin agente disponible, el caso queda en cola y se avisa a supervisión.
- Inicio de llamada y registro de intentos mediante funciones SQL que comprueban rol y asignación.
- Horarios semanales, pausas, historial de intentos, alertas en tiempo real y avisos de escritorio optativos.
- Control de estados para agentes: Disponible, Break, Pausa, Baño, Capacitación y Feedback. El tiempo se registra por turno; solo Break consume la cuota de 60 minutos. Al excederla, el estado y el reporte se marcan en rojo y se genera una alerta única para administración/supervisión.
- El control de estados respeta la disponibilidad: mientras un agente no esté en Disponible no recibe nuevos casos. El reporte de turnos se consulta en **Reportes** y se puede descargar como CSV.
- Alertas servidoras a 10 y 5 minutos, marcación de retraso 10 minutos después y aviso de casos pendientes al cierre del turno.
- Reportes filtrables, descarga CSV e impresión del navegador para guardar como PDF.
- Creación de usuarios por una Edge Function protegida; nunca requiere la clave de servicio en el navegador.
- Importación masiva de usuarios para administradores desde archivos `.xlsx`, `.xls` o `.csv`, con validación por fila y resultados de altas. La primera hoja requiere las columnas `nombre`, `usuario`, `correo` y `contraseña`; `rol` es opcional, acepta `agent`, `quality`, `supervisor` o `admin` y, si falta o queda vacío, se interpreta como `agent`. En **Equipo → Importar desde Excel** se puede descargar una plantilla.
- La dirección antigua `dashboard.html` redirige al panel actual `admin.html`; si se conserva un enlace de versiones anteriores, la importación queda disponible en **Equipo → Importar desde Excel**.

Las contraseñas del archivo se procesan en el navegador y se envían a la Edge Function protegida de Supabase mediante HTTPS; no se incluyen en el informe de resultados. Usa contraseñas temporales, protege el archivo y elimínalo cuando termine la carga. Las filas válidas se crean individualmente: los errores de una fila no cancelan las demás.

El tiempo de sesión se actualiza cada minuto. El cierre de sesión normal registra la salida; si se cierra el navegador inesperadamente, se usa la última actividad registrada y se marca como cierre estimado al reconectar. Los horarios de turnos existentes siguen siendo independientes.

Los gráficos presentan conteos por estado y métricas calculadas sobre los casos recuperados. No se declaran como fuentes de datos los indicadores que aún no tienen integración propia.

## Requisitos

- Proyecto de Supabase.
- Supabase CLI para desplegar las Edge Functions.
- Un servidor HTTP estático para publicar los archivos. No abras las páginas directamente con `file://`, porque los módulos JavaScript necesitan un origen HTTP.

## Configuración

1. En Supabase, abre **SQL Editor** y ejecuta, en este orden, `database/schema.sql`, `database/policies.sql` y `database/seed.sql`. Al actualizar una instalación existente, vuelve a ejecutar los dos primeros archivos antes de publicar el frontend; incluyen el historial de estados, sus permisos y el reporte. El cron existente `callback-manager-process-alerts` procesa también las alertas de Break. Si PostgREST aún indica que no encuentra una tabla recién agregada, ejecuta `NOTIFY pgrst, 'reload schema';` y vuelve a cargar la aplicación.
2. En `js/config.js`, reemplaza `url` y `anonKey` por la URL del proyecto y la clave pública `anon`/publishable. Esta clave es pública por diseño; RLS es la barrera de seguridad. No pegues la `service_role` en ningún archivo del navegador.
3. En **Authentication → URL Configuration**, configura el dominio de despliegue y su URL de redirección. En producción, desactiva el registro público (`Allow new users to sign up`); las cuentas se crean desde la interfaz de administración.
4. Instala/inicia sesión con Supabase CLI y enlaza el proyecto:

   ```sh
   supabase login
   supabase link --project-ref TU_PROJECT_REF
   ```

5. Configura los secretos de las Edge Functions en Supabase (no en `js/config.js`):

   ```sh
   supabase secrets set SUPABASE_URL=https://TU-PROYECTO.supabase.co
   supabase secrets set SUPABASE_ANON_KEY=TU-CLAVE-PUBLICA-ANON
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=TU-CLAVE-SERVICE-ROLE
   supabase secrets set CRON_SECRET=UN_SECRETO_LARGO_ALEATORIO
   ```

   `SUPABASE_SERVICE_ROLE_KEY` y `CRON_SECRET` son confidenciales. Guárdalos solo en los secretos del proyecto.

6. Despliega las funciones:

   ```sh
   supabase functions deploy login-username
   supabase functions deploy assign-callback
   supabase functions deploy create-user
   supabase functions deploy process-alerts
   ```

   Tras actualizar esta versión, vuelve a desplegar `create-user` para permitir altas de usuarios de Calidad.

7. Configura el primer administrador:
   - Crea una cuenta desde **Authentication → Users**.
   - Copia su UUID y ejecuta en SQL Editor:

   ```sql
   update public.profiles set role = 'admin' where id = 'UUID-DEL-USUARIO';
   delete from public.agents where id = 'UUID-DEL-USUARIO';
   delete from public.supervisors where id = 'UUID-DEL-USUARIO';
   ```

   A partir de ahí el administrador puede dar de alta agentes, supervisores y usuarios de Calidad en **Equipo**. Define los turnos de agentes en **Horarios** antes de asignarles casos. Las cuentas nuevas no tienen turnos por defecto.

   Si ya existían perfiles antes de agregar usuario, `schema.sql` les asigna uno inicial con el formato `parte-del-correo_abcdef0`; el usuario también aparece en **Equipo**. Las cuentas nuevas reciben el usuario que se indique al crearlas.

8. Programa las alertas. Habilita las extensiones `pg_cron`, `pg_net` y Vault desde **Database → Extensions**. Guarda una entrada Vault cuyo nombre sea `callback_manager_cron_secret` y cuyo valor coincida con `CRON_SECRET`. Después registra el cron en SQL Editor, sustituyendo el dominio:

   ```sql
   select cron.schedule(
     'callback-manager-process-alerts',
     '* * * * *',
     $job$
       select net.http_post(
         url := 'https://TU-PROYECTO.supabase.co/functions/v1/process-alerts',
         headers := jsonb_build_object(
           'Content-Type', 'application/json',
           'x-cron-secret', (select decrypted_secret
             from vault.decrypted_secrets
             where name = 'callback_manager_cron_secret')
         ),
         body := '{}'::jsonb
       );
     $job$
   );
   ```

   Confirma en **Database → Cron** que el job se ejecuta cada minuto. El endpoint rechaza llamadas sin el secreto de cron.

9. Para usar la URL gratuita de GitHub Pages, abre el repositorio y ve a **Settings → Pages**:
   - Deja **Deploy from a branch**, selecciona `main` y la carpeta raíz (`/`).
   - En **Custom domain**, borra `call-manager.me` y guarda el cambio. No necesitas configurar ningún DNS ni comprar un dominio.
   - La URL gratuita tendrá el formato `https://USUARIO.github.io/REPOSITORIO/`; copia la dirección exacta que GitHub muestra en **Settings → Pages**. Para este proyecto debería ser `https://Bleyser7w7.github.io/CALL-MANAGER/`.

10. En Supabase, abre **Authentication → URL Configuration** y establece como **Site URL** la URL gratuita que muestra GitHub Pages. Agrega también como **Redirect URL** esa misma URL seguida de `login.html`, por ejemplo `https://Bleyser7w7.github.io/CALL-MANAGER/login.html`. Guarda los cambios y prueba el inicio y la recuperación de contraseña. Prueba los cuatro roles, los permisos de solo lectura de Calidad, RLS, asignación, pausas, cron y notificaciones antes de cargar datos reales.

## Zona horaria y reportes

Los horarios se guardan como hora local del día de semana y la asignación/alertas usan `America/Lima`. Los instantes de llamadas y callbacks se almacenan como `timestamptz`. La exportación CSV indica el instante programado en UTC; la interfaz lo presenta en hora de Lima. PDF se genera desde el diálogo de impresión del navegador (**Imprimir → Guardar como PDF**).

## Estructura

- `js/`: módulos de autenticación, datos, callbacks, turnos, notificaciones, reportes y vistas.
- `database/`: esquema, funciones SQL, RLS y datos iniciales.
- `supabase/functions/`: asignación, creación segura de usuarios y procesamiento programado de alertas.
- `css/`: tema, componentes del dashboard y responsive.

## Seguridad operativa

- No hay claves reales en el repositorio. `js/config.js` solo admite configuración pública de Supabase.
- Las tablas tienen RLS y las acciones sensibles de llamada/asignación se validan en SQL.
- Los datos de administración de usuarios se procesan con `service_role` exclusivamente dentro de Edge Functions.
- Usa HTTPS, contraseñas fuertes, políticas de retención apropiadas y pruebas de RLS independientes antes del despliegue.
