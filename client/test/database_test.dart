import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:elsi/data/db/database.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase db;

  setUp(() => db = AppDatabase(NativeDatabase.memory()));
  tearDown(() => db.close());

  test('stores a page with a block and reads it back', () async {
    await db.into(db.pages).insert(PagesCompanion.insert(
          id: 'p1',
          position: 'a0',
          hlc: '1-0-dev',
        ));
    await db.into(db.blocks).insert(BlocksCompanion.insert(
          id: 'b1',
          pageId: 'p1',
          position: 'a0',
          type: 'paragraph',
          hlc: '1-0-dev',
        ));

    final blocks = await db.select(db.blocks).get();
    expect(blocks.single.pageId, 'p1');
    expect(blocks.single.content, '{}');
    expect(blocks.single.deleted, isFalse);
  });

  test('FTS5 finds block text', () async {
    await db.customStatement(
      "INSERT INTO block_fts (block_id, page_id, body) VALUES ('b1', 'p1', 'meeting notes about sync')",
    );
    final rows = await db
        .customSelect("SELECT block_id FROM block_fts WHERE block_fts MATCH 'sync'")
        .get();
    expect(rows.single.read<String>('block_id'), 'b1');
  });
}
