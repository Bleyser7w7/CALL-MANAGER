# Callback Manager

Aplicación web de gestión de devoluciones de llamada con Supabase Auth, PostgreSQL, RLS, Realtime y Edge Functions. La interfaz se sirve como archivos estáticos y mantiene el tema oscuro en todas las pantallas.

## Instancia enlazada

Este workspace está enlazado al proyecto Supabase `pyxxwjkiecdpqvhjxglz`. Su esquema y políticas ya se instalaron, las Edge Functions se desplegaron y el cron `callback-manager-process-alerts` está activo. La URL y la clave pública están configuradas en `js/config.js`.

Pendiente para empezar a usarlo: crear el primer usuario en **Authentication → Users**, promoverlo a administrador (ver el paso 7 de Configuración) y publicar el frontend estático en un hosting HTTPS.

## Funcionalidad incluida

- Inicio/cierre de sesión, recuperación de contraseña y vistas protegidas por rol.
- Inicio de sesión con usuario único; el correo se conserva para recuperar la contraseña y recibir comunicaciones de la cuenta.
- Registro de callbacks con responsable, programación, prioridad y datos del cliente.
- Asignación manual o automática con carga equilibrada; el servidor solo asigna durante el turno y fuera de pausas. Sin agente disponible, el caso queda en cola y se avisa a supervisión.
- Inicio de llamada y registro de intentos mediante funciones SQL que comprueban rol y asignación.
- Horarios semanales, pausas, historial de intentos, alertas en tiempo real y avisos de escritorio optativos.
- Alertas servidoras a 10 y 5 minutos, marcación de retraso 10 minutos después y aviso de casos pendientes al cierre del turno.
- Reportes filtrables, descarga CSV e impresión del navegador para guardar como PDF.
- Creación de usuarios por una Edge Function protegida; nunca requiere la clave de servicio en el navegador.

Los gráficos presentan conteos por estado y métricas calculadas sobre los casos recuperados. No se declaran como fuentes de datos los indicadores que aún no tienen integración propia.

## Requisitos

- Proyecto de Supabase.
- Supabase CLI para desplegar las Edge Functions.
- Un servidor HTTP estático para publicar los archivos. No abras las páginas directamente con `file://`, porque los módulos JavaScript necesitan un origen HTTP.

## Configuración

1. En Supabase, abre **SQL Editor** y ejecuta, en este orden, `database/schema.sql`, `database/policies.sql` y `database/seed.sql`.
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

7. Configura el primer administrador:
   - Crea una cuenta desde **Authentication → Users**.
   - Copia su UUID y ejecuta en SQL Editor:

   ```sql
   update public.profiles set role = 'admin' where id = 'UUID-DEL-USUARIO';
   delete from public.agents where id = 'UUID-DEL-USUARIO';
   delete from public.supervisors where id = 'UUID-DEL-USUARIO';
   ```

   A partir de ahí el administrador puede dar de alta agentes y supervisores en **Equipo**. Define sus turnos en **Horarios** antes de asignarles casos. Las cuentas nuevas no tienen turnos por defecto.

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

9. Publica el directorio en un hosting estático con HTTPS. Prueba los tres roles, RLS, asignación, pausas, cron y notificaciones con usuarios/casos de prueba antes de cargar datos reales.

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
