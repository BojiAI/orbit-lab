export function clearPlot({ stars, trails }) {
  trails.forEach(trail => trail.points.clear());
  stars.forEach(star => star.setAttribute('visibility', 'hidden'));
}

export function draw({ stars, trails }, { values }) {
  stars.forEach((star, i) => {
    const point = star.ownerSVGElement.createSVGPoint();
    point.x = values[1 + 6 * i];
    point.y = values[2 + 6 * i];
    trails[i].points.appendItem(point);
    star.cx.baseVal.value = point.x;
    star.cy.baseVal.value = point.y;
    star.setAttribute('visibility', 'visible');
  });
}
