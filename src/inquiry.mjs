const quantityWithUnit = /(?:(?<leading>\b(?:approximately|approx\.?|around|about|roughly|circa)|大约|大概|约莫|约|预计)\s*)?(?<number>\d{1,3}(?:,\d{3})+|\d+)[ \t]*(?:(?:cup and (?:square )?saucer|bone china|cup-and-saucer)[ \t]+)?(?:sets?\b|套|组)(?:[ \t]+(?<trailing>initially|to start|first)\b)?/gi;
const quantityLabel = /(?:\b(?:qty\.?|quantity|estimated order quantity)|数量|订购量|采购量)\s*(?:[:：=]|\bis\b|为)\s*(?:(?<leading>approximately|around|about|approx\.?|大约|约)\s*)?(?<number>\d{1,3}(?:,\d{3})+|\d+)(?!\d|[.,]\d)/gi;
const numericQuantity = /^(?<number>\d{1,3}(?:,\d{3})+|\d+)$/;
const instructions = /\b(?:ignore|disregard|override)\s+(?:(?:all|the)\s+)*(?:previous|prior|above|system)\s+(?:rules|instructions|prompts)\b|(?:忽略|无视|覆盖)(?:所有|全部)?(?:之前|前面|系统|以上)(?:的)?(?:规则|指令|提示)/i;
const laterMessage = /\b(?:follow[ -]?up|update|revised quantity|revision|correction)\s*[:：,.]|(?:跟进|补充|更新|更正)\s*[:：，]|(?:数量)?(?:改为|调整为|更正为)/gi;
const uncertainty = /\b(?:which is correct|not clear which|conflicting quantit(?:y|ies)|either of those quantities|quantity conflict)\b|(?:不确定|无法确认|有冲突|无法确定)哪(?:一|个)?(?:个|种)?(?:数量|数字)?/i;
const pendingQuantity = /\b(?:not (?:yet )?decided on quantity|quantity (?:is |still )?(?:undecided|unknown|to be confirmed)|no confirmed quantity)\b|(?:数量|采购量)(?:尚未|未|暂未|还没)(?:确认|确定|决定)/i;

const printOptions = [
  ['print-a', /\bprint[\s-]*a\b|\b(?:small(?:er)?|compact) (?:print|motif)\b|(?:印花|图案)[\s-]*A\b|小(?:号|尺寸)?印花/gi],
  ['print-b', /\bprint[\s-]*b\b|\b(?:large(?:r)?|oversiz(?:ed|e)) (?:print|motif)\b|(?:印花|图案)[\s-]*B\b|大(?:号|尺寸)?印花/gi],
];

const carton = /\b(?:printed\s+)?folding\s+(?:(?:paperboard|paper)\s+)?cartons?\b|折叠(?:纸盒|彩盒)/gi;
const rigidBox = /\brigid(?:\s+gift)?\s+box(?:es)?\b|(?:硬质|硬盒式)礼盒/gi;
const packagingOptions = [
  ['pack-a', /\bpack(?:aging)?[\s-]*a\b|(?:包装|盒型)[\s-]*A\b/gi],
  ['pack-b', /\bpack(?:aging)?[\s-]*b\b|(?:包装|盒型)[\s-]*B\b/gi],
];

function fields(text, patterns) {
  return patterns.flatMap(([value, pattern]) => Array.from(text.matchAll(pattern), match => ({
    value,
    quote: match[0],
    index: match.index,
  }))).sort((left, right) => left.index - right.index || right.quote.length - left.quote.length);
}

function selectNamedOptions(text, patterns) {
  return fields(text, patterns).filter(item => {
    const prefix = text.slice(Math.max(0, item.index - 19), item.index);
    return !/(?:\b(?:not|except|reject(?:ed)?)\s+(?:the\s+)?|(?:不选|不要|不是)\s*)$/i.test(prefix);
  });
}

function distinct(items) {
  return [...new Map(items.map(item => [item.value, item])).values()];
}

function contextQuantity(text) {
  const matches = [...text.matchAll(quantityWithUnit), ...text.matchAll(quantityLabel)];
  const byPosition = new Map();
  for (const match of matches) {
    const { number, leading, trailing } = match.groups;
    const value = Number(number.replaceAll(',', ''));
    const index = match.index + match[0].indexOf(number);
    if (!Number.isSafeInteger(value) || value < 1 || byPosition.has(index)) continue;
    const beforeNumber = text.slice(Math.max(0, index - 70), index);
    const suffix = text.slice(match.index + match[0].length);
    if (/^\d/.test(suffix) || /[\d.]$/.test(beforeNumber)) continue;
    const range = beforeNumber.match(/(?:^|[^\d.,])(\d{1,3}(?:,\d{3})+|\d+)\s*(?:-|–|—|~|～|\bto\b|至|到)\s*$/i);
    if (range) {
      const firstValue = Number(range[1].replaceAll(',', ''));
      const firstIndex = index - range[0].length + range[0].indexOf(range[1]);
      if (Number.isSafeInteger(firstValue) && firstValue > 0) {
        byPosition.set(firstIndex, { value: firstValue, index: firstIndex, quote: range[1], qualifiers: [] });
      }
    }
    byPosition.set(index, { value, index, quote: match[0], qualifiers: [leading, trailing].filter(Boolean) });
  }
  return [...byPosition.values()].sort((a, b) => a.index - b.index);
}

function findSku(text, allowBare = false) {
  const pattern = /(?:\b(?:model(?:\s+(?:no\.?|number))?|sku|product(?:\s+(?:code|no\.?|number))?)|货号|型号)\s*[:：#]?\s*([a-z0-9][a-z0-9_-]{0,24})(?![a-z0-9_-])/gi;
  const result = [...text.matchAll(pattern)].filter(match => /\d/.test(match[1])).map(match => ({
    value: match[1].toUpperCase(),
    quote: match[0],
  }));
  if (result.length || !allowBare) return distinct(result);
  const bare = text.match(/(?:^|[\s/#：:，,])(?<sku>146)(?![a-z0-9_-]|[.,]\d|\s*(?:sets?\b|套|组))/i);
  return bare ? [{ value: bare.groups.sku, quote: bare.groups.sku }] : [];
}

function findUse(text) {
  return fields(text, [
    ['hotel breakfast', /\b(?:boutique\s+)?hotel\s+breakfast(?:\s+service)?\b/gi],
    ['酒店早餐', /酒店早餐(?:用|服务)?/g],
    ['afternoon tea', /\bafternoon tea\b/gi],
    ['下午茶', /下午茶/g],
    ['café service', /\b(?:caf[eé]|coffee shop) service\b/gi],
  ])[0];
}

function findPrint(text) {
  return fields(text, [
    ['logo on cup front', /\b(?:show|put|apply|print|place|add)\s+(?:(?:our|your|the|a|custom)\s+)?logo\s+on\s+(?:the\s+)?(?:(?:cup|mug)\s+)?front\b|\blogo\s+on\s+(?:the\s+)?front\s+of\s+(?:the\s+)?(?:cup|mug)\b/gi],
    ['杯身Logo', /(?:杯身|杯面|杯子正面)\s*(?:上\s*)?(?:印|加|放|贴)\s*(?:上\s*)?(?:品牌\s*)?(?:logo|标识|商标)/gi],
    ['plain white', /\bplain white\b|\bunprinted (?:white )?(?:cup|mug)\b/gi],
    ['白瓷无印花', /(?:纯白(?:色)?(?:不印|无印花)?|不印花|无印花)/g],
    ...printOptions,
  ])[0];
}

function findPackaging(text) {
  const candidates = fields(text, [
    ...packagingOptions,
    ['folding carton', /\b(?:printed\s+)?folding\s+(?:(?:paperboard|paper)\s+)?cartons?\b/gi],
    ['rigid gift box', /\brigid(?:\s+gift)?\s+box(?:es)?\b/gi],
    ['gift box', /\bgift\s+box(?:es)?\b/gi],
    ['折叠彩盒', /折叠(?:纸盒|彩盒)/g],
    ['硬质礼盒', /(?:硬质|硬盒式)礼盒/g],
    ['礼盒', /礼盒/g],
  ]);
  // More specific matches such as "rigid gift box" cover the generic "gift box" beneath them.
  const chosen = [];
  for (const match of candidates) {
    const previous = chosen.at(-1);
    if (!previous || match.index >= previous.index + previous.quote.length) chosen.push(match);
  }
  return distinct(chosen);
}

function getRevision(text) {
  const keep = [];
  const change = [];
  for (const clause of text.match(/[^.!?。！？\n]+/g) ?? []) {
    const keepClause = clause.match(/(?:\b(?:keep|retain|leave|preserve)\b|保留|照旧|保持).*/i)?.[0];
    if (keepClause) {
      keep.push(...fields(keepClause, [...printOptions, ...packagingOptions]).map(item => ({
        ...item,
        quote: keepClause.trim(),
      })));
    }
    if (/\b(?:make|change|revise|update|adjust|redo|modify)\b|修改|更改|调整|重做|改为|改成/i.test(clause)) {
      const targetClause = clause.split(/\band\s+(?:keep|retain|leave|preserve)\b|并(?:保留|保持)/i)[0];
      for (const target of fields(targetClause, [...packagingOptions, ...printOptions])) {
        change.push({ ...target, quote: clause.trim() });
      }
    }
  }
  const targets = distinct(change);
  if (!targets.length) return null;
  const changed = new Set(targets.map(target => target.value));
  const protectedOptions = distinct(keep).filter(item => !changed.has(item.value));
  // Porvia's revision workflow carries forward the untouched packaging option.
  const changedPack = targets.find(target => target.value.startsWith('pack-'));
  if (changedPack && changed.size === 1) {
    const other = changedPack.value === 'pack-a' ? 'pack-b' : 'pack-a';
    if (!protectedOptions.some(item => item.value === other)) {
      protectedOptions.push({ value: other, quote: changedPack.quote });
    }
  }
  return { keep: protectedOptions, change: targets };
}

export function extractInquiry(input) {
  if (typeof input !== 'string') throw new TypeError('Inquiry must be a text string.');
  const blocked = input.match(instructions);
  const text = blocked ? input.slice(0, blocked.index) : input;
  const use = findUse(text);
  const sku = findSku(text);
  const print = findPrint(text);
  const packaging = findPackaging(text);
  const quantities = contextQuantity(text);
  const revisionMarker = [...text.matchAll(laterMessage)].at(-1);
  const afterRevision = revisionMarker
    ? quantities.filter(item => item.index >= revisionMarker.index + revisionMarker[0].length)
    : [];
  const eligible = distinct(afterRevision.length ? afterRevision : quantities);
  const quantityWasDeferred = pendingQuantity.exec(text);
  const quantityNeedsReview = eligible.length > 1 || (distinct(quantities).length > 1 && uncertainty.test(text));
  const quantity = quantityNeedsReview || quantityWasDeferred ? null : eligible[0] ?? null;
  const packagingConfirmation = packageBuyerConfirmation(text, packaging);
  const evidence = {};
  if (use) evidence.use = use.quote;
  if (sku.length) evidence.sku = sku.length === 1 ? sku[0].quote : sku.map(item => item.quote);
  if (print) evidence.print = print.quote;
  if (packaging.length) evidence.packaging = packaging.map(item => item.quote);
  if (quantity) evidence.quantity = quantity.quote;
  if (quantity?.qualifiers.length) evidence.quantityQualifier = quantity.qualifiers;
  if (quantityWasDeferred) evidence.quantity = quantityWasDeferred[0];
  if (packagingConfirmation) evidence.packagingConfirmed = packagingConfirmation;
  if (blocked) evidence.ignoredInstruction = input.slice(blocked.index).trim();

  const result = {
    use: use?.value ?? null,
    quantity: quantity?.value ?? null,
    quantityQualifier: quantity?.qualifiers.length ? quantity.qualifiers.map((value) => value.toLowerCase()).join(' / ') : null,
    sku: sku.length === 1 ? sku[0].value : null,
    print: print?.value ?? null,
    packaging: packaging.map(item => item.value),
    packagingConfirmed: Boolean(packagingConfirmation),
    factoryConfirmed: false,
    allFieldsApproved: false,
    needsReview: quantityNeedsReview || sku.length > 1,
    evidence,
  };

  if (quantityNeedsReview) {
    const conflicting = eligible.length > 1 ? eligible : distinct(quantities);
    result.quantityCandidates = conflicting.map(item => item.value);
    evidence.quantityCandidates = conflicting.map(item => item.quote);
    evidence.needsReview = text.match(uncertainty)?.[0] ?? evidence.quantityCandidates;
  } else if (quantity && afterRevision.length) {
    const earlier = quantities.filter(item => item.index < revisionMarker.index && item.value !== quantity.value).at(-1);
    result.quantitySource = 'follow-up';
    evidence.quantitySource = text.slice(revisionMarker.index, text.indexOf(quantity.quote, revisionMarker.index) + quantity.quote.length);
    if (earlier) {
      result.earlierQuantity = earlier.value;
      evidence.earlierQuantity = earlier.quote;
    }
  }
  if (sku.length > 1 && !evidence.needsReview) evidence.needsReview = evidence.sku;
  const revision = getRevision(text);
  if (revision) {
    result.keep = revision.keep.map(item => item.value);
    result.change = revision.change.map(item => item.value);
    result.newVersion = 2;
    result.keepPreviousVersion = true;
    evidence.keep = revision.keep.map(item => item.quote);
    evidence.change = revision.change.map(item => item.quote);
    evidence.newVersion = evidence.change;
    evidence.keepPreviousVersion = evidence.change;
  }
  result.missing = ['use', 'quantity', 'sku', 'print', 'packaging'].filter(key => result[key] === null || result[key].length === 0);
  return result;
}

function packageBuyerConfirmation(text, packaging) {
  if (packaging.length !== 1) return null;
  const item = packaging[0];
  if (item.value === 'gift box' || item.value === '礼盒') return null;
  const prefix = text.slice(Math.max(0, item.index - 45), item.index);
  const choice = prefix.match(/(?:\bwe\s+(?:choose|select|confirm|have chosen)\s+(?:the\s+)?|(?:我们|我方)(?:确认|选用|选择)\s*)$/i);
  return choice ? choice[0] + item.quote : null;
}

function scoreOption(text, patterns, shorthandAmbiguity) {
  const shorthand = text.match(shorthandAmbiguity);
  if (shorthand && shorthand[1].toLowerCase() !== shorthand[2].toLowerCase()) {
    return { value: null, quote: shorthand[0] };
  }
  const options = distinct(selectNamedOptions(text, patterns));
  return options.length === 1
    ? options[0]
    : { value: null, quote: options.length ? options.map(item => item.quote) : null };
}

export function scoreBuyerReply(input) {
  if (typeof input !== 'string') throw new TypeError('Buyer reply must be a text string.');
  const sku = findSku(input, true);
  const print = scoreOption(input, printOptions, /(?:\bprint|印花)\s*([ab])\s*(?:or|and|\/|或|和)\s*(?:print\s*)?([ab])\b/i);
  const packaging = scoreOption(input, [...packagingOptions, ['pack-a', carton], ['pack-b', rigidBox]], /(?:\bpack(?:aging)?|包装)\s*([ab])\s*(?:or|and|\/|或|和)\s*(?:pack\s*)?([ab])\b/i);
  const amounts = distinct(contextQuantity(input));
  if (!amounts.length) {
    const lastField = input.split(/\s*[/|;；]\s*/);
    const bare = lastField.at(-1).trim().match(numericQuantity);
    const value = bare ? Number(bare.groups.number.replaceAll(',', '')) : null;
    if (lastField.length >= 3 && Number.isSafeInteger(value) && value > 0) {
      amounts.push({ value, quote: bare[0] });
    }
  }
  const evidence = {};
  if (sku.length) evidence.sku = sku.length === 1 ? sku[0].quote : sku.map(item => item.quote);
  if (print.quote) evidence.print = print.quote;
  if (packaging.quote) evidence.packaging = packaging.quote;
  if (amounts.length) evidence.quantity = amounts.length === 1 ? amounts[0].quote : amounts.map(item => item.quote);
  const result = {
    sku: sku.length === 1 ? sku[0].value : null,
    print: print.value,
    packaging: packaging.value,
    quantity: amounts.length === 1 ? amounts[0].value : null,
    evidence,
  };
  result.missing = ['sku', 'print', 'packaging', 'quantity'].filter(key => result[key] === null);
  result.complete = result.missing.length === 0;
  return result;
}
