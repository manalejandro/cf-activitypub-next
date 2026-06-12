"use client";

import { createContext, useContext, useEffect, useState } from "react";

// ─── Translation dictionaries ─────────────────────────────────────────────────

const EN = {
  // Navigation
  nav_home: "Home",
  nav_explore: "Explore",
  nav_notifications: "Notifications",
  nav_profile: "Profile",
  nav_logout: "Log out",
  theme_light: "Light",
  theme_dark: "Dark",
  // Compose
  compose_placeholder: "What's happening?",
  compose_posting: "Posting…",
  compose_post: "Post",
  compose_attach: "Attach image or video (max 4)",
  // Home timeline
  timeline_empty: "Your timeline is empty.",
  timeline_empty_sub: "Follow people to see their posts here.",
  // Notifications
  notif_follow_requests_title: "Follow requests",
  notif_empty: "No notifications yet",
  notif_empty_sub: "When someone follows or interacts with you, it will appear here.",
  notif_followed_you: "followed you",
  notif_follow_request: "requested to follow you",
  notif_mentioned: "mentioned you",
  notif_boosted: "boosted your post",
  notif_liked: "liked your post",
  notif_poll: "A poll you voted in has ended",
  notif_edited: "edited a post",
  // Explore
  explore_search_ph: "People, #tags, posts… @user@domain for remote accounts",
  explore_searching: "Searching…",
  explore_no_results: "No results for",
  explore_remote_tip: "For remote accounts use @user@domain.social",
  explore_resolving: "💡 Resolving remote account via WebFinger",
  explore_tab_trending: "Recent",
  explore_tab_accounts: "Accounts",
  explore_tab_hashtags: "Hashtags",
  explore_tab_posts: "Posts",
  explore_nothing: "Nothing here yet. Be the first!",
  explore_no_accounts: "No accounts found",
  explore_no_hashtags: "No hashtags found",
  explore_no_posts: "No posts found",
  explore_search_tips: "Search tips",
  explore_tip_local: "local account",
  explore_tip_remote: "remote",
  explore_tip_hashtag: "hashtag",
  explore_tip_text: "free text — posts",
  explore_join: "Join",
  explore_create: "Create account",
  explore_signin: "Sign in",
  // Account actions
  account_follow: "Follow",
  account_following: "Following",
  account_requested: "Requested",
  account_view_profile: "Profile",
  notif_accept: "Accept",
  notif_reject: "Reject",
  // Login
  login_title: "Welcome back",
  login_sub: "Sign in to your account",
  login_email: "Email",
  login_password: "Password",
  login_submit: "Sign in",
  login_submitting: "Signing in…",
  login_no_account: "Don't have an account?",
  login_register: "Create one",
  login_unverified: "Please verify your email address before signing in.",
  login_verified_banner: "Email verified! You can now sign in.",
  login_verify_error: "The verification link is invalid or has expired.",
  // Register
  register_title: "Create account",
  register_sub: "Join the open social web",
  register_username: "Username",
  register_email: "Email",
  register_password: "Password",
  register_username_hint: "Letters, numbers and underscores only",
  register_submit: "Create account",
  register_submitting: "Creating account…",
  register_have_account: "Already have an account?",
  register_signin: "Sign in",
  // Email verification flow
  verify_email_title: "Check your email",
  verify_email_sub: "We sent a verification link to",
  verify_email_resend: "Resend verification email",
  verify_email_resending: "Sending…",
  verify_email_resent: "Email sent! Check your inbox.",
  // Turnstile
  turnstile_error: "Security check failed. Please try again.",
  // Profile
  profile_posts: "Posts",
  profile_media: "Media",
  profile_followers: "Followers",
  profile_following: "Following",
  profile_edit: "Edit profile",
  profile_save: "Save",
  profile_saving: "Saving…",
  profile_cancel: "Cancel",
  profile_not_found: "User not found",
  profile_not_found_sub: "This account doesn't exist or has been deleted.",
  profile_display_name: "Display name",
  profile_bio: "Bio",
  profile_avatar: "Avatar",
  profile_header: "Header image",
  profile_follow_requests_manual: "Approve follow requests manually",
  // Timelines
  nav_timelines: "Timelines",
  timeline_local: "Local",
  timeline_federated: "Federated",
  timeline_new_posts: "new posts",
  timeline_public_empty: "No local posts yet.",
  timeline_federated_empty: "No federated posts yet.",
  // Visibility
  compose_visibility: "Visibility",
  vis_public: "Public",
  vis_unlisted: "Unlisted",
  vis_followers: "Followers only",
  vis_direct: "Direct",
  // Hashtag timeline
  hashtag_timeline: "Posts tagged",
  hashtag_empty: "No posts with this hashtag yet.",
  // Common
  loading: "Loading…",
  network_error: "Network error. Please try again.",
};

const ES: typeof EN = {
  // Navegación
  nav_home: "Inicio",
  nav_explore: "Explorar",
  nav_notifications: "Notificaciones",
  nav_profile: "Perfil",
  nav_logout: "Cerrar sesión",
  theme_light: "Claro",
  theme_dark: "Oscuro",
  // Redactar
  compose_placeholder: "¿Qué está pasando?",
  compose_posting: "Publicando…",
  compose_post: "Publicar",
  compose_attach: "Adjuntar imagen o video (máx 4)",
  // Cronología
  timeline_empty: "Tu cronología está vacía.",
  timeline_empty_sub: "Sigue a personas para ver sus publicaciones aquí.",
  // Notificaciones
  notif_follow_requests_title: "Solicitudes de seguimiento",
  notif_empty: "Sin notificaciones",
  notif_empty_sub: "Cuando alguien te siga o interactúe contigo, aparecerá aquí.",
  notif_followed_you: "te siguió",
  notif_follow_request: "solicitó seguirte",
  notif_mentioned: "te mencionó",
  notif_boosted: "impulsó tu publicación",
  notif_liked: "le gustó tu publicación",
  notif_poll: "Una encuesta en la que votaste ha terminado",
  notif_edited: "editó una publicación",
  // Explorar
  explore_search_ph: "Personas, #etiquetas, posts… @user@domain para cuentas remotas",
  explore_searching: "Buscando…",
  explore_no_results: "Sin resultados para",
  explore_remote_tip: "Para cuentas remotas usa @usuario@dominio.social",
  explore_resolving: "💡 Buscando cuenta remota — se resolverá via WebFinger",
  explore_tab_trending: "Recientes",
  explore_tab_accounts: "Cuentas",
  explore_tab_hashtags: "Etiquetas",
  explore_tab_posts: "Posts",
  explore_nothing: "Nada aquí aún. ¡Sé el primero!",
  explore_no_accounts: "No se encontraron cuentas",
  explore_no_hashtags: "No se encontraron etiquetas",
  explore_no_posts: "No se encontraron posts",
  explore_search_tips: "Consejos de búsqueda",
  explore_tip_local: "cuenta local",
  explore_tip_remote: "remoto",
  explore_tip_hashtag: "etiqueta",
  explore_tip_text: "texto libre — posts",
  explore_join: "Únete",
  explore_create: "Crear cuenta",
  explore_signin: "Iniciar sesión",
  // Acciones de cuenta
  account_follow: "Seguir",
  account_following: "Siguiendo",
  account_requested: "Solicitado",
  account_view_profile: "Perfil",
  notif_accept: "Aceptar",
  notif_reject: "Rechazar",
  // Iniciar sesión
  login_title: "Bienvenido de vuelta",
  login_sub: "Inicia sesión en tu cuenta",
  login_email: "Correo electrónico",
  login_password: "Contraseña",
  login_submit: "Iniciar sesión",
  login_submitting: "Iniciando sesión…",
  login_no_account: "¿No tienes cuenta?",
  login_register: "Créate una",
  login_unverified: "Por favor, verifica tu correo electrónico antes de iniciar sesión.",
  login_verified_banner: "¡Correo verificado! Ya puedes iniciar sesión.",
  login_verify_error: "El enlace de verificación es inválido o ha expirado.",
  // Registro
  register_title: "Crear cuenta",
  register_sub: "Únete a la web social abierta",
  register_username: "Nombre de usuario",
  register_email: "Correo electrónico",
  register_password: "Contraseña",
  register_username_hint: "Solo letras, números y guiones bajos",
  register_submit: "Crear cuenta",
  register_submitting: "Creando cuenta…",
  register_have_account: "¿Ya tienes cuenta?",
  register_signin: "Iniciar sesión",
  // Flujo de verificación de correo
  verify_email_title: "Verifica tu correo",
  verify_email_sub: "Enviamos un enlace de verificación a",
  verify_email_resend: "Reenviar correo de verificación",
  verify_email_resending: "Enviando…",
  verify_email_resent: "¡Correo enviado! Revisa tu bandeja de entrada.",
  // Turnstile
  turnstile_error: "Verificación de seguridad fallida. Inténtalo de nuevo.",
  // Perfil
  profile_posts: "Publicaciones",
  profile_media: "Multimedia",
  profile_followers: "Seguidores",
  profile_following: "Siguiendo",
  profile_edit: "Editar perfil",
  profile_save: "Guardar",
  profile_saving: "Guardando…",
  profile_cancel: "Cancelar",
  profile_not_found: "Usuario no encontrado",
  profile_not_found_sub: "Esta cuenta no existe o ha sido eliminada.",
  profile_display_name: "Nombre para mostrar",
  profile_bio: "Biografía",
  profile_avatar: "Avatar",
  profile_header: "Imagen de cabecera",
  profile_follow_requests_manual: "Aprobar manualmente solicitudes de seguimiento",
  // Cronologías
  nav_timelines: "Cronologías",
  timeline_local: "Local",
  timeline_federated: "Federado",
  timeline_new_posts: "nuevos posts",
  timeline_public_empty: "Aún no hay posts locales.",
  timeline_federated_empty: "Aún no hay posts federados.",
  // Visibilidad
  compose_visibility: "Visibilidad",
  vis_public: "Público",
  vis_unlisted: "Sin listar",
  vis_followers: "Solo seguidores",
  vis_direct: "Directo",
  // Cronología de etiquetas
  hashtag_timeline: "Publicaciones con",
  hashtag_empty: "Aún no hay publicaciones con esta etiqueta.",
  // Común
  loading: "Cargando…",
  network_error: "Error de red. Por favor, inténtalo de nuevo.",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type Translations = typeof EN;
export type Locale = "en" | "es";

// ─── Context ──────────────────────────────────────────────────────────────────

const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Translations;
}>({
  locale: "en",
  setLocale: () => {},
  t: EN,
});

// ─── Provider ─────────────────────────────────────────────────────────────────

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  // Always initialize to "en" so server and client render identically (avoids
  // hydration mismatch / React error #418). The correct locale is applied after
  // hydration via useEffect.
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const saved = localStorage.getItem("locale") as Locale | null;
    if (saved === "en" || saved === "es") {
      setLocaleState(saved);
    } else if (navigator.language.slice(0, 2) === "es") {
      setLocaleState("es");
    }
  }, []);

  function setLocale(l: Locale) {
    setLocaleState(l);
    localStorage.setItem("locale", l);
  }

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t: locale === "es" ? ES : EN }}>
      {children}
    </LocaleContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLocale() {
  return useContext(LocaleContext);
}
