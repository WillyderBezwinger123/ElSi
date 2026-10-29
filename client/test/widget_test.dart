import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:elsi/main.dart';

void main() {
  testWidgets('wide screens show the sidebar, narrow ones a drawer', (tester) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    tester.view.physicalSize = const Size(1200, 800);
    await tester.pumpWidget(const ProviderScope(child: ElsiApp()));
    await tester.pumpAndSettle();
    expect(find.text('Notes'), findsOneWidget);
    expect(find.byType(Drawer), findsNothing);

    tester.view.physicalSize = const Size(400, 800);
    await tester.pumpAndSettle();
    expect(find.text('Notes'), findsNothing);
    expect(find.byIcon(Icons.menu), findsOneWidget);
  });
}
