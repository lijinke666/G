import type { CSSUnitValue } from '../css';
import type { DisplayObjectConfig } from '../dom';
import type { BaseStyleProps, ParsedBaseStyleProps } from '../types';
import { Shape } from '../types';
import { DisplayObject } from './DisplayObject';

export interface PolygonStyleProps extends BaseStyleProps {
  points: [number, number][];
  /**
   * marker will be positioned at the first point
   */
  markerStart?: DisplayObject;

  /**
   * marker will be positioned at the last point
   */
  markerEnd?: DisplayObject;

  markerMid?: DisplayObject;

  /**
   * offset relative to original position
   */
  markerStartOffset?: number;

  /**
   * offset relative to original position
   */
  markerEndOffset?: number;
  isClosed?: boolean;
}
export interface ParsedPolygonStyleProps extends ParsedBaseStyleProps {
  points: {
    points: [number, number][];
    segments: [number, number][];
    totalLength: number;
  };
  markerStart?: DisplayObject;
  markerMid?: DisplayObject;
  markerEnd?: DisplayObject;
  markerStartOffset?: CSSUnitValue;
  markerEndOffset?: CSSUnitValue;
  isClosed?: boolean;
}

export class Polygon extends DisplayObject<PolygonStyleProps, ParsedPolygonStyleProps> {
  private markerStartAngle = 0;
  private markerEndAngle = 0;

  /**
   * markers placed at the mid
   */
  private markerMidList: DisplayObject[] = [];

  constructor({ style, ...rest }: DisplayObjectConfig<PolygonStyleProps> = {}) {
    super({
      type: Shape.POLYGON,
      style: {
        points: '',
        miterLimit: '',
        isClosed: true,
        ...style,
      },
      ...rest,
    });

    const { markerStart, markerEnd, markerMid } = this.parsedStyle;

    if (markerStart && markerStart instanceof DisplayObject) {
      this.markerStartAngle = markerStart.getLocalEulerAngles();
      this.appendChild(markerStart);
    }

    if (markerMid && markerMid instanceof DisplayObject) {
      this.placeMarkerMid(markerMid);
    }

    if (markerEnd && markerEnd instanceof DisplayObject) {
      this.markerEndAngle = markerEnd.getLocalEulerAngles();
      this.appendChild(markerEnd);
    }

    this.transformMarker(true);
    this.transformMarker(false);
  }

  attributeChangedCallback<Key extends keyof PolygonStyleProps>(
    attrName: Key,
    oldValue: PolygonStyleProps[Key],
    newValue: PolygonStyleProps[Key],
    prevParsedValue: ParsedPolygonStyleProps[Key],
    newParsedValue: ParsedPolygonStyleProps[Key],
  ) {
    if (attrName === 'points') {
      // recalc markers
      this.transformMarker(true);
      this.transformMarker(false);
      this.placeMarkerMid(this.parsedStyle.markerMid);
    } else if (attrName === 'markerStartOffset' || attrName === 'markerEndOffset') {
      this.transformMarker(true);
      this.transformMarker(false);
    } else if (attrName === 'markerStart') {
      if (prevParsedValue && prevParsedValue instanceof DisplayObject) {
        this.markerStartAngle = 0;
        (prevParsedValue as DisplayObject).remove();
      }

      // CSSKeyword 'unset'
      if (newParsedValue && newParsedValue instanceof DisplayObject) {
        this.markerStartAngle = newParsedValue.getLocalEulerAngles();
        this.appendChild(newParsedValue);
        this.transformMarker(true);
      }
    } else if (attrName === 'markerEnd') {
      if (prevParsedValue && prevParsedValue instanceof DisplayObject) {
        this.markerEndAngle = 0;
        (prevParsedValue as DisplayObject).remove();
      }

      if (newParsedValue && newParsedValue instanceof DisplayObject) {
        this.markerEndAngle = newParsedValue.getLocalEulerAngles();
        this.appendChild(newParsedValue);
        this.transformMarker(false);
      }
    } else if (attrName === 'markerMid') {
      this.placeMarkerMid(newParsedValue as DisplayObject);
    }
  }

  private transformMarker(isStart: boolean) {
    const {
      markerStart,
      markerEnd,
      markerStartOffset,
      markerEndOffset,
      points: { points },
      defX,
      defY,
    } = this.parsedStyle;
    const marker = isStart ? markerStart : markerEnd;

    if (!marker || !(marker instanceof DisplayObject)) {
      return;
    }

    let rad = 0;
    let x: number;
    let y: number;
    let ox: number;
    let oy: number;
    let offset: number;
    let originalAngle: number;

    ox = points[0][0] - defX;
    oy = points[0][1] - defY;

    if (isStart) {
      x = points[1][0] - points[0][0];
      y = points[1][1] - points[0][1];
      offset = markerStartOffset?.value || 0;
      originalAngle = this.markerStartAngle;
    } else {
      const { length } = points;

      if (!this.style.isClosed) {
        ox = points[length - 1][0] - defX;
        oy = points[length - 1][1] - defY;
        x = points[length - 2][0] - points[length - 1][0];
        y = points[length - 2][1] - points[length - 1][1];
      } else {
        x = points[length - 1][0] - points[0][0];
        y = points[length - 1][1] - points[0][1];
      }
      offset = markerEndOffset?.value || 0;
      originalAngle = this.markerEndAngle;
    }
    rad = Math.atan2(y, x);

    // account for markerOffset
    marker.setLocalEulerAngles((rad * 180) / Math.PI + originalAngle);
    marker.setLocalPosition(ox + Math.cos(rad) * offset, oy + Math.sin(rad) * offset);
  }

  private placeMarkerMid(marker: DisplayObject) {
    const {
      points: { points },
      defX,
      defY,
    } = this.parsedStyle;

    // clear all existed markers
    this.markerMidList.forEach((marker) => {
      marker.remove();
    });

    if (marker && marker instanceof DisplayObject) {
      for (let i = 1; i < (this.style.isClosed ? points.length : points.length - 1); i++) {
        const ox = points[i][0] - defX;
        const oy = points[i][1] - defY;

        const cloned = i === 1 ? marker : marker.cloneNode(true);
        this.markerMidList.push(cloned);

        this.appendChild(cloned);
        cloned.setLocalPosition(ox, oy);

        // TODO: orient of marker
      }
    }
  }
}
