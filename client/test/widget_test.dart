import 'package:drift/native.dart';
import 'package:elsi/data/db/database.dart';
import 'package:elsi/data/providers.dart';
import 'package:elsi/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('wide screens show the sidebar, narrow ones a drawer', (tester) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final db = AppDatabase(NativeDatabase.memory());

    tester.view.physicalSize = const Size(1200, 800);
    await tester.pumpWidget(ProviderScope(
      overrides: [databaseProvider.overrideWithValue(db)],
      child: const ElsiApp(),
    ));
    await tester.pumpAndSettle();
    expect(find.byTooltip('New page'), findsOneWidget);
    expect(find.byType(Drawer), findsNothing);

    tester.view.physicalSize = const Size(400, 800);
    await tester.pumpAndSettle();
    expect(find.byTooltip('New page'), findsNothing);
    expect(find.byIcon(Icons.menu), findsOneWidget);

    // Unmount first so drift's stream-close timer fires inside the test,
    // then close the database.
    await tester.pumpWidget(const SizedBox());
    await tester.pump(Duration.zero);
    await db.close();
  });
}
