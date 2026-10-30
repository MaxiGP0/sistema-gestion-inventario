import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Corre axe sobre la página actual y falla solo con violaciones serious o
 * critical. Las moderadas quedan visibles en el reporte de Playwright sin
 * bloquear la suite.
 */
export async function expectNoSeriousA11yViolations(page: Page, label: string): Promise<void> {
  // Los diálogos y toasts entran con una animación corta de opacidad/scale.
  // Axe calcula contraste sobre el color efectivo: si corre a mitad de la
  // animación, el texto se mezcla con el fondo oscuro y reporta un falso
  // positivo. Esperar a que terminen las animaciones finitas (con un tope de
  // 500 ms para no colgarse con animaciones infinitas) estabiliza el análisis.
  await page.evaluate(async () => {
    const animations = document.getAnimations?.() ?? [];
    const finite = animations.filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return timing && Number.isFinite(timing.endTime);
    });

    await Promise.all(
      finite.map((animation) =>
        Promise.race([
          animation.finished.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]),
      ),
    );
  });

  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );

  const details = blocking
    .map((violation) => {
      const nodes = violation.nodes
        .map((node) => `    - ${node.target.join(' ')}: ${node.failureSummary ?? ''}`)
        .join('\n');

      return `${violation.id} (${violation.impact}): ${violation.help}\n${nodes}`;
    })
    .join('\n\n');

  expect(
    blocking,
    `${label}: axe detectó ${blocking.length} violación(es) serious/critical.\n${details}`,
  ).toEqual([]);
}
