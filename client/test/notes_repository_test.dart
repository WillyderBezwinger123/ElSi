import 'package:appflowy_editor/appflowy_editor.dart';
import 'package:drift/native.dart';
import 'package:elsi/data/db/database.dart';
import 'package:elsi/data/hlc.dart';
import 'package:elsi/data/notes_repository.dart';
import 'package:flutter_test/flutter_test.dart';

Document _doc(List<String> paragraphs) => Document(
      root: Node(
        type: 'page',
        children: [for (final p in paragraphs) paragraphNode(text: p)],
      ),
    );

void main() {
  late AppDatabase db;
  late NotesRepository repo;

  setUp(() {
    db = AppDatabase(NativeDatabase.memory());
    repo = NotesRepository(db, Hlc('test'));
  });
  tearDown(() => db.close());

  test('document survives a save and reload with stable block ids', () async {
    final pageId = await repo.createPage(title: 'Plan');
    final doc = _doc(['first', 'second']);
    await repo.saveDocument(pageId, doc);

    final loaded = await repo.loadDocument(pageId);
    expect(loaded.root.children.map((n) => n.delta?.toPlainText()), ['first', 'second']);
    expect(loaded.root.children.map((n) => n.id), doc.root.children.map((n) => n.id));
  });

  test('unchanged blocks do not move their clock on re-save', () async {
    final pageId = await repo.createPage();
    final doc = _doc(['same']);
    await repo.saveDocument(pageId, doc);
    final before = await db.select(db.blocks).get();
    await repo.saveDocument(pageId, doc);
    final after = await db.select(db.blocks).get();
    expect(after.single.hlc, before.single.hlc);
  });

  test('removed blocks become tombstones and leave search', () async {
    final pageId = await repo.createPage();
    final doc = _doc(['alpha keeper', 'beta goner']);
    await repo.saveDocument(pageId, doc);
    expect(await repo.search('goner'), [pageId]);

    // Keep the first node (same id), drop the second, as the editor would.
    final keeper = doc.root.children.first;
    await repo.saveDocument(pageId, Document(root: Node(type: 'page', children: [keeper])));
    expect(await repo.search('goner'), isEmpty);
    expect(await repo.search('keeper'), [pageId]);

    final blocks = await db.select(db.blocks).get();
    expect(blocks.where((b) => b.deleted), hasLength(1));
  });

  test('deleted pages are hidden but queued for sync', () async {
    final pageId = await repo.createPage();
    await repo.deletePage(pageId);
    expect(await repo.watchPages().first, isEmpty);
    final ops = await db.select(db.outbox).get();
    expect(ops.last.payload, contains('delete'));
  });
}
