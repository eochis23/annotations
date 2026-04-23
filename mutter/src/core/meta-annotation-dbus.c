/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include "core/meta-annotation-dbus.h"

#include "compositor/meta-annotation-layer.h"

struct _MetaAnnotationDBus
{
  MetaAnnotationLayer *layer;
  GDBusConnection      *connection;
  guint                 registration_id;
  guint                 name_owner_id;
};

static void
handle_method_call (GDBusConnection       *connection,
                    const gchar           *sender,
                    const gchar           *object_path,
                    const gchar           *interface_name,
                    const gchar           *method_name,
                    GVariant              *parameters,
                    GDBusMethodInvocation *invocation,
                    gpointer               user_data)
{
  MetaAnnotationDBus *dbus = user_data;

  if (g_strcmp0 (interface_name, "org.gnome.Mutter.Annotation") != 0)
    {
      g_dbus_method_invocation_return_error (invocation,
                                             G_DBUS_ERROR,
                                             G_DBUS_ERROR_UNKNOWN_INTERFACE,
                                             "Unknown interface");
      return;
    }

  if (g_strcmp0 (method_name, "Clear") == 0)
    {
      meta_annotation_layer_clear (dbus->layer);
      g_dbus_method_invocation_return_value (invocation, NULL);
    }
  else if (g_strcmp0 (method_name, "SetActive") == 0)
    {
      gboolean active;

      g_variant_get (parameters, "(b)", &active);
      meta_annotation_layer_set_active (dbus->layer, active);
      g_dbus_method_invocation_return_value (invocation, NULL);
    }
  else if (g_strcmp0 (method_name, "SetColor") == 0)
    {
      double r, g, b, a;

      g_variant_get (parameters, "(dddd)", &r, &g, &b, &a);
      /* #region agent log */
      {
        char p[512];
        const char *home = g_get_home_dir ();
        if (home && *home)
          g_snprintf (p, sizeof p, "%s/mutter-annot-debug-da8410.log", home);
        else
          g_strlcpy (p, "/tmp/mutter-annot-debug-da8410.log", sizeof p);
        FILE *f = fopen (p, "a");
        if (f)
          {
            fprintf (f,
                     "{\"sessionId\":\"da8410\",\"hypothesisId\":\"H7+H8\","
                     "\"location\":\"meta-annotation-dbus.c:SetColor\","
                     "\"message\":\"handle_method_call SetColor\","
                     "\"data\":{\"r\":%.3f,\"g\":%.3f,\"b\":%.3f,\"a\":%.3f,\"sender\":\"%s\"},"
                     "\"timestamp\":%lld}\n",
                     r, g, b, a, sender ? sender : "",
                     (long long) (g_get_real_time () / 1000));
            fclose (f);
          }
      }
      /* #endregion */
      meta_annotation_layer_set_color (dbus->layer, r, g, b, a);
      g_dbus_method_invocation_return_value (invocation, NULL);
    }
  else if (g_strcmp0 (method_name, "SetChromeRegions") == 0)
    {
      g_autoptr (GVariant) regions = NULL;

      g_variant_get (parameters, "(@a(siiii))", &regions);
      meta_annotation_layer_set_chrome_regions (dbus->layer, regions);
      g_dbus_method_invocation_return_value (invocation, NULL);
    }
  else if (g_strcmp0 (method_name, "ClearChromeRegions") == 0)
    {
      meta_annotation_layer_clear_chrome_regions (dbus->layer);
      g_dbus_method_invocation_return_value (invocation, NULL);
    }
  else
    {
      g_dbus_method_invocation_return_error (invocation,
                                             G_DBUS_ERROR,
                                             G_DBUS_ERROR_UNKNOWN_METHOD,
                                             "Unknown method");
    }
}

static const gchar introspection_xml[] =
  "<node>"
  "  <interface name='org.gnome.Mutter.Annotation'>"
  "    <method name='Clear'/>"
  "    <method name='SetActive'>"
  "      <arg type='b' name='active' direction='in'/>"
  "    </method>"
  "    <method name='SetColor'>"
  "      <arg type='d' name='r' direction='in'/>"
  "      <arg type='d' name='g' direction='in'/>"
  "      <arg type='d' name='b' direction='in'/>"
  "      <arg type='d' name='a' direction='in'/>"
  "    </method>"
  "    <method name='SetChromeRegions'>"
  "      <arg type='a(siiii)' name='regions' direction='in'/>"
  "    </method>"
  "    <method name='ClearChromeRegions'/>"
  "    <signal name='RegionActivated'>"
  "      <arg type='s' name='id'/>"
  "      <arg type='s' name='kind'/>"
  "    </signal>"
  "  </interface>"
  "</node>";

static const GDBusInterfaceVTable interface_vtable = {
  .method_call = handle_method_call,
};

static void
on_bus_acquired (GDBusConnection *connection,
                 const gchar     *name,
                 gpointer         user_data)
{
  MetaAnnotationDBus *dbus = user_data;
  g_autoptr (GDBusNodeInfo) node_info = NULL;

  g_clear_object (&dbus->connection);
  dbus->connection = g_object_ref (connection);
  GDBusInterfaceInfo *iface_info;
  GError *local_error = NULL;

  node_info = g_dbus_node_info_new_for_xml (introspection_xml, &local_error);
  if (!node_info)
    {
      g_warning ("annotation-dbus: failed to parse introspection: %s",
                 local_error->message);
      g_clear_error (&local_error);
      return;
    }

  iface_info = g_dbus_node_info_lookup_interface (node_info,
                                                  "org.gnome.Mutter.Annotation");
  g_assert (iface_info != NULL);

  dbus->registration_id =
    g_dbus_connection_register_object (connection,
                                       "/org/gnome/Mutter/Annotation",
                                       iface_info,
                                       &interface_vtable,
                                       dbus,
                                       NULL,
                                       &local_error);
  if (dbus->registration_id == 0)
    {
      g_warning ("annotation-dbus: register_object failed: %s",
                 local_error->message);
      g_clear_error (&local_error);
    }
}

static void
on_name_lost (GDBusConnection *connection,
              const gchar      *name,
              gpointer          user_data)
{
  MetaAnnotationDBus *dbus = user_data;

  if (connection && dbus->registration_id != 0)
    {
      g_dbus_connection_unregister_object (connection, dbus->registration_id);
      dbus->registration_id = 0;
    }
  g_clear_object (&dbus->connection);
}

MetaAnnotationDBus *
meta_annotation_dbus_new (MetaAnnotationLayer *layer)
{
  MetaAnnotationDBus *dbus;

  g_return_val_if_fail (layer != NULL, NULL);

  dbus = g_new0 (MetaAnnotationDBus, 1);
  dbus->layer = layer;

  dbus->name_owner_id =
    g_bus_own_name (G_BUS_TYPE_SESSION,
                    "org.gnome.Mutter.Annotation",
                    G_BUS_NAME_OWNER_FLAGS_ALLOW_REPLACEMENT |
                    G_BUS_NAME_OWNER_FLAGS_REPLACE,
                    on_bus_acquired,
                    NULL,
                    on_name_lost,
                    dbus,
                    NULL);

  return dbus;
}

void
meta_annotation_dbus_free (MetaAnnotationDBus *dbus)
{
  if (!dbus)
    return;

  if (dbus->name_owner_id)
    g_bus_unown_name (dbus->name_owner_id);

  if (dbus->connection && dbus->registration_id != 0)
    {
      g_dbus_connection_unregister_object (dbus->connection, dbus->registration_id);
      dbus->registration_id = 0;
    }

  g_clear_object (&dbus->connection);
  g_free (dbus);
}

void
meta_annotation_dbus_emit_region_activated (MetaAnnotationDBus *dbus,
                                            const char         *id,
                                            const char         *kind)
{
  GError *local_error = NULL;

  if (!dbus || !dbus->connection || !id || !kind)
    return;

  if (!g_dbus_connection_emit_signal (dbus->connection,
                                      NULL,
                                      "/org/gnome/Mutter/Annotation",
                                      "org.gnome.Mutter.Annotation",
                                      "RegionActivated",
                                      g_variant_new ("(ss)", id, kind),
                                      &local_error))
    {
      g_warning ("annotation-dbus: emit RegionActivated failed: %s",
                 local_error->message);
      g_clear_error (&local_error);
    }
}
