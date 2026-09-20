package dev.fpbcraft.bluemaprailway;

import com.simibubi.create.Create;
import com.simibubi.create.content.trains.entity.Carriage;
import com.simibubi.create.content.trains.entity.Train;
import com.simibubi.create.content.trains.entity.TravellingPoint;
import com.simibubi.create.content.trains.graph.EdgePointType;
import com.simibubi.create.content.trains.graph.TrackEdge;
import com.simibubi.create.content.trains.graph.TrackGraph;
import com.simibubi.create.content.trains.graph.TrackNode;
import com.simibubi.create.content.trains.signal.SignalBoundary;
import com.simibubi.create.content.trains.signal.SignalEdgeGroup;
import com.simibubi.create.content.trains.station.GlobalStation;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

final class RailwaySnapshot {
  private static final double TRACK_SAMPLE_SPACING = 2.0;
  private static final double EPSILON = 1.0e-4;

  static Snapshot capture(MinecraftServer server) {
    Snapshot snapshot = new Snapshot();
    snapshot.generatedAt = System.currentTimeMillis();

    for (TrackGraph graph : Create.RAILWAYS.trackNetworks.values()) {
      captureGraph(snapshot, graph);
    }

    for (Train train : Create.RAILWAYS.trains.values()) {
      captureTrain(snapshot, server, train);
    }

    snapshot.dimensions.values().forEach(DimensionData::sort);
    return snapshot;
  }

  private static void captureGraph(Snapshot snapshot, TrackGraph graph) {
    captureStations(snapshot, graph);
    captureSignals(snapshot, graph);
    captureSegments(snapshot, graph);
  }

  private static void captureStations(Snapshot snapshot, TrackGraph graph) {
    for (GlobalStation station : graph.getPoints(EdgePointType.STATION)) {
      var node1 = graph.locateNode(station.edgeLocation.getFirst());
      var node2 = graph.locateNode(station.edgeLocation.getSecond());
      if (node1 == null || node2 == null) continue;

      TrackEdge edge = graph.getConnectionsFrom(node1).get(node2);
      if (edge == null || edge.isInterDimensional() || edge.getLength() <= EPSILON) continue;

      double distance = station.getLocationOn(edge);
      Vec3 trackPosition = edge.getPosition(graph, clamp01(distance / edge.getLength()));
      ResourceKey<Level> dimension =
          station.getBlockEntityDimension() != null
              ? station.getBlockEntityDimension()
              : node1.getLocation().getDimension();
      if (dimension == null) continue;

      Vec3 position = trackPosition;
      if (station.getBlockEntityPos() != null) {
        var blockPos = station.getBlockEntityPos();
        position = new Vec3(blockPos.getX() + 0.5, blockPos.getY() + 0.5, blockPos.getZ() + 0.5);
      }

      StationDto dto = new StationDto();
      dto.id = station.getId().toString();
      dto.name = station.name;
      dto.x = position.x;
      dto.y = position.y;
      dto.z = position.z;
      dto.assembling = station.assembling;
      dto.presentTrain = trainName(station.getPresentTrain());
      dto.imminentTrain = trainName(station.getImminentTrain());
      snapshot.dimension(dimension).stations.add(dto);
    }
  }

  private static void captureSignals(Snapshot snapshot, TrackGraph graph) {
    for (SignalBoundary signal : graph.getPoints(EdgePointType.SIGNAL)) {
      ResourceKey<Level> dimension = signal.edgeLocation.getFirst().getDimension();
      if (dimension == null) continue;

      for (boolean side : List.of(Boolean.FALSE, Boolean.TRUE)) {
        var blockEntities = signal.blockEntities.get(side);
        if (blockEntities == null || blockEntities.isEmpty()) continue;

        String state = signal.cachedStates.get(side).name();
        String type = signal.types.get(side).name();
        UUID group = signal.groups.get(side);

        blockEntities.forEach(
            (pos, powered) -> {
              SignalDto dto = new SignalDto();
              dto.id = signal.getId() + ":" + (side ? "1" : "0") + ":" + pos.asLong();
              dto.signalId = signal.getId().toString();
              dto.group = group == null ? null : group.toString();
              dto.x = pos.getX() + 0.5;
              dto.y = pos.getY() + 0.9;
              dto.z = pos.getZ() + 0.5;
              dto.state = state;
              dto.type = type;
              dto.powered = Boolean.TRUE.equals(powered);
              snapshot.dimension(dimension).signals.add(dto);
            });
      }
    }
  }

  private static void captureSegments(Snapshot snapshot, TrackGraph graph) {
    Set<String> visited = new HashSet<>();

    for (var location : graph.getNodes()) {
      TrackNode node1 = graph.locateNode(location);
      if (node1 == null) continue;

      for (var entry : graph.getConnectionsFrom(node1).entrySet()) {
        TrackNode node2 = entry.getKey();
        TrackEdge edge = entry.getValue();
        if (node2 == null || edge == null || edge.isInterDimensional()) continue;

        int minNode = Math.min(node1.getNetId(), node2.getNetId());
        int maxNode = Math.max(node1.getNetId(), node2.getNetId());
        String edgeKey = graph.id + ":" + minNode + ":" + maxNode;
        if (!visited.add(edgeKey)) continue;

        ResourceKey<Level> dimension = node1.getLocation().getDimension();
        if (dimension == null || !dimension.equals(node2.getLocation().getDimension())) continue;

        double length = edge.getLength();
        if (length <= EPSILON) continue;

        List<Double> cuts = new ArrayList<>();
        cuts.add(0.0);
        cuts.add(length);
        edge.getEdgeData().getPoints().stream()
            .filter(point -> point instanceof SignalBoundary)
            .map(point -> point.getLocationOn(edge))
            .filter(distance -> distance > EPSILON && distance < length - EPSILON)
            .forEach(cuts::add);
        cuts.sort(Comparator.naturalOrder());
        cuts = dedupe(cuts);

        for (int i = 0; i < cuts.size() - 1; i++) {
          double start = cuts.get(i);
          double end = cuts.get(i + 1);
          if (end - start <= EPSILON) continue;

          double midpoint = (start + end) / 2.0;
          UUID groupId = edge.getEdgeData().getGroupAtPosition(graph, midpoint);
          SignalEdgeGroup group =
              groupId == null ? null : Create.RAILWAYS.signalEdgeGroups.get(groupId);

          SegmentDto dto = new SegmentDto();
          dto.id = edgeKey + ":" + i;
          dto.group = groupId == null ? null : groupId.toString();
          dto.status = groupStatus(group);
          dto.signaled = edge.getEdgeData().hasSignalBoundaries();
          dto.fallback = group != null && group.fallbackGroup;
          dto.trains =
              group == null
                  ? List.of()
                  : group.trains.stream()
                      .map(RailwaySnapshot::trainName)
                      .filter(s -> s != null && !s.isBlank())
                      .sorted()
                      .toList();
          dto.trainIds =
              group == null
                  ? List.of()
                  : group.trains.stream()
                      .map(train -> train.id.toString())
                      .sorted()
                      .toList();
          dto.points = sample(edge, graph, start, end);
          snapshot.dimension(dimension).segments.add(dto);
        }
      }
    }
  }

  private static void captureTrain(Snapshot snapshot, MinecraftServer server, Train train) {
    TrainPosition trainPosition = trainPosition(train);
    if (trainPosition == null || trainPosition.dimension == null) return;

    TrainDto dto = new TrainDto();
    dto.id = train.id.toString();
    dto.name = trainName(train);
    dto.x = trainPosition.position.x;
    dto.y = trainPosition.position.y + 1.25;
    dto.z = trainPosition.position.z;
    dto.speed = train.speed;
    dto.targetSpeed = train.targetSpeed;
    dto.state = trainState(train);
    dto.backwards = train.currentlyBackwards;
    dto.carriages = train.carriages.size();
    dto.owner = trainOwner(server, train);

    GlobalStation current = train.getCurrentStation();
    if (current != null) {
      dto.currentStation = current.name;
      dto.targetStation = current.name;
      dto.targetDistance = 0;
    } else if (train.navigation.destination != null && !train.runtime.paused) {
      dto.targetStation = train.navigation.destination.name;
      dto.targetDistance = Math.max(0, (int) Math.floor(train.navigation.distanceToDestination));
    }

    dto.waitingForSignal = train.navigation.waitingForSignal != null;
    snapshot.dimension(trainPosition.dimension).trains.add(dto);
  }

  private static TrainPosition trainPosition(Train train) {
    if (train.graph == null || train.carriages.isEmpty()) return null;

    Carriage carriage =
        train.currentlyBackwards
            ? train.carriages.get(train.carriages.size() - 1)
            : train.carriages.get(0);
    TravellingPoint point =
        train.currentlyBackwards ? carriage.getTrailingPoint() : carriage.getLeadingPoint();
    if (point == null
        || point.node1 == null
        || point.edge == null
        || point.edge.isInterDimensional()) {
      return null;
    }

    ResourceKey<Level> dimension = point.node1.getLocation().getDimension();
    if (dimension == null) return null;
    return new TrainPosition(dimension, point.getPosition(train.graph));
  }

  private static String trainState(Train train) {
    if (train.derailed) return "DERAILED";

    boolean stopped = Math.abs(train.speed) < 0.05;
    if (train.runtime.getSchedule() != null && stopped) {
      if (train.runtime.paused) return "SCHEDULE_INTERRUPTED";
      if (train.status.conductor) return "CONDUCTOR_MISSING";
      if (train.status.navigation) return "NAVIGATION_FAILED";
    }

    if ((train.runtime.getSchedule() == null || train.runtime.paused) && train.speed != 0) {
      return "RUNNING_MANUALLY";
    }
    return "RUNNING";
  }

  private static String trainOwner(MinecraftServer server, Train train) {
    if (train.owner == null) return null;
    var owner = server.getPlayerList().getPlayer(train.owner);
    return owner == null ? null : owner.getName().getString();
  }

  private static String trainName(Train train) {
    return train == null || train.name == null ? null : train.name.getString();
  }

  private static String groupStatus(SignalEdgeGroup group) {
    if (group == null) return "FREE";
    if (!group.trains.isEmpty()) return "OCCUPIED";
    if (group.reserved != null) return "RESERVED";
    return group.fallbackGroup ? "PASSIVE" : "FREE";
  }

  private static List<PointDto> sample(
      TrackEdge edge, TrackGraph graph, double start, double end) {
    int samples = Math.max(1, (int) Math.ceil((end - start) / TRACK_SAMPLE_SPACING));
    List<PointDto> points = new ArrayList<>(samples + 1);
    double length = edge.getLength();
    for (int i = 0; i <= samples; i++) {
      double distance = start + (end - start) * i / samples;
      Vec3 p = edge.getPosition(graph, clamp01(distance / length));
      points.add(new PointDto(p.x, p.y + 0.15, p.z));
    }
    return points;
  }

  private static List<Double> dedupe(List<Double> values) {
    List<Double> result = new ArrayList<>();
    for (double value : values) {
      if (result.isEmpty() || Math.abs(result.get(result.size() - 1) - value) > EPSILON) {
        result.add(value);
      }
    }
    return result;
  }

  private static double clamp01(double value) {
    return Math.max(0, Math.min(1, value));
  }

  static final class Snapshot {
    long generatedAt;
    Map<String, DimensionData> dimensions = new HashMap<>();

    DimensionData dimension(ResourceKey<Level> key) {
      return dimensions.computeIfAbsent(key.location().toString(), ignored -> new DimensionData());
    }
  }

  static final class DimensionData {
    List<StationDto> stations = new ArrayList<>();
    List<SignalDto> signals = new ArrayList<>();
    List<SegmentDto> segments = new ArrayList<>();
    List<TrainDto> trains = new ArrayList<>();

    void sort() {
      stations.sort(
          Comparator.comparing(
              station -> station.name, Comparator.nullsLast(String::compareToIgnoreCase)));
      signals.sort(Comparator.comparing(signal -> signal.id));
      segments.sort(Comparator.comparing(segment -> segment.id));
      trains.sort(
          Comparator.comparing(
              train -> train.name, Comparator.nullsLast(String::compareToIgnoreCase)));
    }
  }

  static final class StationDto {
    String id;
    String name;
    double x;
    double y;
    double z;
    boolean assembling;
    String presentTrain;
    String imminentTrain;
  }

  static final class SignalDto {
    String id;
    String signalId;
    String group;
    double x;
    double y;
    double z;
    String state;
    String type;
    boolean powered;
  }

  static final class SegmentDto {
    String id;
    String group;
    String status;
    boolean signaled;
    boolean fallback;
    List<String> trains;
    List<String> trainIds;
    List<PointDto> points;
  }

  static final class TrainDto {
    String id;
    String name;
    double x;
    double y;
    double z;
    double speed;
    double targetSpeed;
    String state;
    boolean backwards;
    int carriages;
    String owner;
    String currentStation;
    String targetStation;
    int targetDistance;
    boolean waitingForSignal;
  }

  static final class PointDto {
    double x;
    double y;
    double z;

    PointDto(double x, double y, double z) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
  }

  private record TrainPosition(ResourceKey<Level> dimension, Vec3 position) {}

  private RailwaySnapshot() {}
}
