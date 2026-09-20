package dev.fpbcraft.bluemaprailway;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Collection;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.function.Consumer;
import net.minecraft.server.MinecraftServer;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Mod(BlueMapCreateRailway.MOD_ID)
public final class BlueMapCreateRailway {
  static final String MOD_ID = "bluemap_create_railway";
  private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
  private static final Logger LOGGER = LoggerFactory.getLogger("BlueMapCreateRailway");
  private static final int SNAPSHOT_INTERVAL_TICKS = 20;

  private final String version;
  private volatile Object blueMapApi;
  private volatile MinecraftServer server;
  private volatile Path addonRoot;
  private int ticks;

  public BlueMapCreateRailway(ModContainer container) {
    version = container.getModInfo().getVersion().toString();

    NeoForge.EVENT_BUS.addListener(this::serverStarted);
    NeoForge.EVENT_BUS.addListener(this::serverStopping);
    NeoForge.EVENT_BUS.addListener(this::serverTick);

    connectBlueMap();
  }

  private void connectBlueMap() {
    try {
      Class<?> apiType = Class.forName("de.bluecolored.bluemap.api.BlueMapAPI");
      apiType
          .getMethod("onEnable", Consumer.class)
          .invoke(
              null,
              (Consumer<Object>)
                  api -> {
                    blueMapApi = api;
                    installWebAddon();
                  });
      apiType
          .getMethod("onDisable", Consumer.class)
          .invoke(
              null,
              (Consumer<Object>)
                  ignored -> {
                    blueMapApi = null;
                    addonRoot = null;
                  });
    } catch (ClassNotFoundException ignored) {
      LOGGER.warn("BlueMap is not installed; Create railway web integration is disabled.");
    } catch (ReflectiveOperationException exception) {
      LOGGER.error("Could not attach to the BlueMap API", exception);
    }
  }

  private void serverStarted(ServerStartedEvent event) {
    server = event.getServer();
    ticks = 0;
    installWebAddon();
    writeSnapshot();
  }

  private void serverStopping(ServerStoppingEvent event) {
    server = null;
    addonRoot = null;
    ticks = 0;
  }

  private void serverTick(ServerTickEvent.Post event) {
    if (++ticks < SNAPSHOT_INTERVAL_TICKS) return;
    ticks = 0;
    writeSnapshot();
  }

  private synchronized void installWebAddon() {
    if (blueMapApi == null || server == null) return;

    try {
      Object webApp = call(blueMapApi, "BlueMapAPI", "getWebApp", new Class<?>[0]);
      Path webRoot = (Path) call(webApp, "WebApp", "getWebRoot", new Class<?>[0]);
      Path root = webRoot.resolve("create-railway");
      Files.createDirectories(root);

      String script = installAsset(root, "create-railway.js");
      String style = installAsset(root, "create-railway.css");
      writeIntegration(root);

      call(
          webApp,
          "WebApp",
          "registerScript",
          new Class<?>[] {String.class},
          "create-railway/" + script);
      call(
          webApp,
          "WebApp",
          "registerStyle",
          new Class<?>[] {String.class},
          "create-railway/" + style);

      addonRoot = root;
      LOGGER.info("Create railway overlay installed in BlueMap web app at {}", root);
    } catch (Exception exception) {
      addonRoot = null;
      LOGGER.error("Could not install the Create railway BlueMap addon", exception);
    }
  }

  private String installAsset(Path root, String resourceName) throws IOException {
    int extension = resourceName.lastIndexOf('.');
    String installedName =
        resourceName.substring(0, extension)
            + "-"
            + version
            + resourceName.substring(extension);
    try (var input = getClass().getResourceAsStream("/" + resourceName)) {
      if (input == null) throw new IOException("Missing bundled asset " + resourceName);
      Files.copy(input, root.resolve(installedName), StandardCopyOption.REPLACE_EXISTING);
    }
    return installedName;
  }

  private void writeIntegration(Path root) throws ReflectiveOperationException, IOException {
    Map<String, String> mapWorlds = new TreeMap<>();
    for (var level : server.getAllLevels()) {
      Optional<?> world =
          (Optional<?>)
              call(
                  blueMapApi,
                  "BlueMapAPI",
                  "getWorld",
                  new Class<?>[] {Object.class},
                  level);
      if (world.isEmpty()) continue;

      for (Object map :
          (Collection<?>) call(world.get(), "BlueMapWorld", "getMaps", new Class<?>[0])) {
        String mapId = (String) call(map, "BlueMapMap", "getId", new Class<?>[0]);
        mapWorlds.put(mapId, level.dimension().location().toString());
      }
    }

    Map<String, Object> integration =
        Map.of(
            "version", version,
            "pollIntervalMs", 1000,
            "mapWorlds", mapWorlds);
    atomicWrite(root.resolve("integration.json"), GSON.toJson(integration));
  }

  private void writeSnapshot() {
    MinecraftServer currentServer = server;
    Path root = addonRoot;
    if (currentServer == null || root == null) return;

    try {
      RailwaySnapshot.Snapshot snapshot = RailwaySnapshot.capture(currentServer);
      atomicWrite(root.resolve("state.json"), GSON.toJson(snapshot));
    } catch (Exception exception) {
      LOGGER.warn("Could not update BlueMap Create railway state", exception);
    }
  }

  private static Object call(
      Object target, String iface, String method, Class<?>[] argumentTypes, Object... arguments)
      throws ReflectiveOperationException {
    return Class.forName("de.bluecolored.bluemap.api." + iface)
        .getMethod(method, argumentTypes)
        .invoke(target, arguments);
  }

  private static void atomicWrite(Path path, String contents) throws IOException {
    Files.createDirectories(path.getParent());
    Path temp = path.resolveSibling(path.getFileName() + ".tmp");
    Files.writeString(
        temp,
        contents,
        StandardCharsets.UTF_8,
        StandardOpenOption.CREATE,
        StandardOpenOption.TRUNCATE_EXISTING,
        StandardOpenOption.WRITE);
    try {
      Files.move(
          temp,
          path,
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING);
    } catch (AtomicMoveNotSupportedException exception) {
      Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING);
    }
  }
}
