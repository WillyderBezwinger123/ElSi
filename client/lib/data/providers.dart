import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'db/database.dart';
import 'hlc.dart';
import 'notes_repository.dart';

final databaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase();
  ref.onDispose(db.close);
  return db;
});

/// Identifies this install in clock values. Persisting it per device comes
/// with auth and sync in M2.
final hlcProvider = Provider<Hlc>((ref) => Hlc(newId().substring(0, 8)));

final notesRepositoryProvider = Provider<NotesRepository>(
  (ref) => NotesRepository(ref.watch(databaseProvider), ref.watch(hlcProvider)),
);

final pagesProvider = StreamProvider<List<Page>>(
  (ref) => ref.watch(notesRepositoryProvider).watchPages(),
);
