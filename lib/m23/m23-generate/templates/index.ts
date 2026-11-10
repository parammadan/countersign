import type { AgreementTemplate, Kind } from "../types";
import { services } from "./services";
import { nda } from "./nda";
import { lease } from "./lease";
import { retainer } from "./retainer";
import { engagement } from "./engagement";
import { consulting } from "./consulting";
import { licence } from "./licence";

export const TEMPLATES: Record<Kind, AgreementTemplate> = { services, nda, lease, retainer, engagement, consulting, licence };
export const KINDS = Object.keys(TEMPLATES) as Kind[];
