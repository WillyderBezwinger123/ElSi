import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'database.g.dart';

/// A page in the page tree. Ids are client-generated UUIDv7 strings.
class Pages extends Table {
  TextColumn get id => text()();
  TextColumn get parentId => text().nullable()();
  TextColumn get title => text().withDefault(const Constant(''))();
  TextColumn get icon => text().nullable()();
  TextColumn get position => text()(); // fractional index among siblings
  BoolColumn get aiVisible => boolean().withDefault(const Constant(true))();
  TextColumn get hlc => text()();
  BoolColumn get deleted => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

/// A block inside a page. `content` holds the block's JSON, which is the
/// source of truth (the editor document is only a view of it).
class Blocks extends Table {
  TextColumn get id => text()();
  TextColumn get pageId => text().references(Pages, #id)();
  TextColumn get parentId => text().nullable()();
  TextColumn get position => text()();
  TextColumn get type => text()();
  TextColumn get content => text().withDefault(const Constant('{}'))();
  TextColumn get hlc => text()();
  BoolColumn get deleted => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

/// Local edits not yet pushed to the server.
class Outbox extends Table {
  IntColumn get seq => integer().autoIncrement()();
  TextColumn get entity => text()(); // 'page' | 'block'
  TextColumn get entityId => text()();
  TextColumn get payload => text()();
  TextColumn get hlc => text()();
}

@DriftDatabase(tables: [Pages, Blocks, Outbox])
class AppDatabase extends _$AppDatabase {
  AppDatabase([QueryExecutor? executor])
      : super(executor ?? driftDatabase(name: 'elsi'));

  @override
  int get schemaVersion => 1;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) async {
          await m.createAll();
          // Full-text search over block text (kept in sync by the repository).
          await customStatement(
            'CREATE VIRTUAL TABLE IF NOT EXISTS block_fts USING fts5('
            'block_id UNINDEXED, page_id UNINDEXED, body)',
          );
        },
      );
}
