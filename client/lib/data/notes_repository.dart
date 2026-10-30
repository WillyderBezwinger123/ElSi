import 'dart:convert';

import 'package:appflowy_editor/appflowy_editor.dart';
import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import 'db/database.dart';
import 'hlc.dart';

const _uuid = Uuid();

String newId() => _uuid.v7();

bool _isUuid(String id) => id.length == 36;

/// Reads and writes pages and blocks. Each top-level editor node is stored as
/// one block row whose `content` is the node's JSON (including its children).
class NotesRepository {
  NotesRepository(this._db, this._hlc);

  final AppDatabase _db;
  final Hlc _hlc;

  Stream<List<Page>> watchPages() {
    final q = _db.select(_db.pages)
      ..where((p) => p.deleted.equals(false))
      ..orderBy([(p) => OrderingTerm.asc(p.position)]);
    return q.watch();
  }

  Future<Page?> getPage(String id) {
    return (_db.select(_db.pages)..where((p) => p.id.equals(id))).getSingleOrNull();
  }

  Future<String> createPage({String? parentId, String title = ''}) async {
    final id = newId();
    final hlc = _hlc.now();
    await _db.transaction(() async {
      await _db.into(_db.pages).insert(PagesCompanion.insert(
            id: id,
            parentId: Value(parentId),
            title: Value(title),
            position: hlc, // creation order for now; reordering comes later
            hlc: hlc,
          ));
      await _enqueue('page', id, {'op': 'upsert'}, hlc);
    });
    return id;
  }

  Future<void> renamePage(String id, String title) async {
    final hlc = _hlc.now();
    await _db.transaction(() async {
      await (_db.update(_db.pages)..where((p) => p.id.equals(id)))
          .write(PagesCompanion(title: Value(title), hlc: Value(hlc)));
      await _enqueue('page', id, {'op': 'upsert'}, hlc);
    });
  }

  /// Soft-deletes a page (tombstone) so the deletion can sync.
  Future<void> deletePage(String id) async {
    final hlc = _hlc.now();
    await _db.transaction(() async {
      await (_db.update(_db.pages)..where((p) => p.id.equals(id)))
          .write(PagesCompanion(deleted: const Value(true), hlc: Value(hlc)));
      await _enqueue('page', id, {'op': 'delete'}, hlc);
    });
  }

  Future<Document> loadDocument(String pageId) async {
    final rows = await (_db.select(_db.blocks)
          ..where((b) => b.pageId.equals(pageId) & b.deleted.equals(false))
          ..orderBy([(b) => OrderingTerm.asc(b.position)]))
        .get();
    if (rows.isEmpty) return Document.blank(withInitialText: true);

    final nodes = rows.map((row) {
      final json = Map<String, Object>.from(jsonDecode(row.content) as Map);
      return Node.fromJson(json)..id = row.id; // Node.fromJson drops ids
    });
    return Document(root: Node(type: 'page', children: nodes));
  }

  /// Persists the document: upserts changed top-level nodes and tombstones
  /// removed ones. Unchanged blocks are left alone so their clocks don't move.
  Future<void> saveDocument(String pageId, Document document) async {
    final existing = {
      for (final b in await (_db.select(_db.blocks)
            ..where((b) => b.pageId.equals(pageId)))
          .get())
        b.id: b,
    };
    final seen = <String>{};

    await _db.transaction(() async {
      var index = 0;
      for (final node in document.root.children) {
        if (!_isUuid(node.id)) node.id = newId();
        seen.add(node.id);

        final content = jsonEncode(node.toJson());
        final position = (index++).toString().padLeft(8, '0');
        final old = existing[node.id];
        if (old != null &&
            !old.deleted &&
            old.content == content &&
            old.position == position) {
          continue;
        }

        final hlc = _hlc.now();
        await _db.into(_db.blocks).insertOnConflictUpdate(BlocksCompanion.insert(
              id: node.id,
              pageId: pageId,
              position: position,
              type: node.type,
              content: Value(content),
              hlc: hlc,
            ));
        await _indexBlock(node.id, pageId, _plainText(node));
        await _enqueue('block', node.id, {'op': 'upsert'}, hlc);
      }

      for (final old in existing.values) {
        if (seen.contains(old.id) || old.deleted) continue;
        final hlc = _hlc.now();
        await (_db.update(_db.blocks)..where((b) => b.id.equals(old.id)))
            .write(BlocksCompanion(deleted: const Value(true), hlc: Value(hlc)));
        await _db.customStatement('DELETE FROM block_fts WHERE block_id = ?', [old.id]);
        await _enqueue('block', old.id, {'op': 'delete'}, hlc);
      }
    });
  }

  /// Full-text search over block text. Returns matching page ids.
  Future<List<String>> search(String query) async {
    final text = query.trim().replaceAll('"', '');
    if (text.isEmpty) return [];
    final rows = await _db.customSelect(
      'SELECT DISTINCT f.page_id FROM block_fts f '
      'JOIN pages p ON p.id = f.page_id AND p.deleted = 0 '
      'WHERE block_fts MATCH ?',
      variables: [Variable.withString('"$text"*')],
    ).get();
    return rows.map((r) => r.read<String>('page_id')).toList();
  }

  Future<void> _indexBlock(String blockId, String pageId, String body) async {
    await _db.customStatement('DELETE FROM block_fts WHERE block_id = ?', [blockId]);
    if (body.isEmpty) return;
    await _db.customStatement(
      'INSERT INTO block_fts (block_id, page_id, body) VALUES (?, ?, ?)',
      [blockId, pageId, body],
    );
  }

  Future<void> _enqueue(
    String entity,
    String entityId,
    Map<String, Object> payload,
    String hlc,
  ) {
    return _db.into(_db.outbox).insert(OutboxCompanion.insert(
          entity: entity,
          entityId: entityId,
          payload: jsonEncode(payload),
          hlc: hlc,
        ));
  }
}

String _plainText(Node node) {
  final buffer = StringBuffer();
  final text = node.delta?.toPlainText();
  if (text != null && text.isNotEmpty) buffer.writeln(text);
  for (final child in node.children) {
    buffer.write(_plainText(child));
  }
  return buffer.toString().trim();
}
