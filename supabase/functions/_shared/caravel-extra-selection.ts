/**
 * Caravel supplier-priced optional equipment. Only the authoritative provider
 * reference and POST /v1/quote may determine the cost. Never synthesize fees.
 * The existing partner_extras/local billing engine must not be used for Caravel.
 */
type Obj = Record<string,unknown>;
const obj = (x:unknown):Obj|null => !!x && typeof x==="object" && !Array.isArray(x) ? x as Obj:null;
const MONEY = (x:unknown,currency:string):number|null => {
 const v=obj(x);return v?.currency===currency && typeof v.amount==="number" &&
  Number.isSafeInteger(v.amount) && v.amount>=0 ? v.amount:null;
};
const ID=/^[A-Za-z0-9._-]{1,128}$/;
export type CaravelExtra = {
 extra_id:string;code:string;name_en:string;name_pl:string;
 category:string;pricing_type:"per_day"|"per_rental";unit_minor:number;
 price_cap_minor:number|null;currency:string;max_quantity:number;
 payable:"at_pickup";mutually_exclusive_group:string|null;
};
export type CaravelExtraChoice={extra_id:string;quantity:number};
export type CaravelPricedExtra={extra_id:string;code:string;quantity:number;name_en:string;name_pl:string;total_minor:number};
const PL:Record<string,string>={
 child_seat:"Fotelik dziecięcy",booster_seat:"Podstawka dla dziecka",
 navigation:"Nawigacja GPS",gps:"Nawigacja GPS",additional_driver:"Dodatkowy kierowca",
 snow_chains:"Łańcuchy śniegowe",wifi:"Internet Wi-Fi",
};
export function caravelSafeExtraCatalog(raw:unknown,supplierId:string,currency="EUR"):{
 catalog:CaravelExtra[];unavailable:Array<{name:string;reason:string}>
}{
 if(!Array.isArray(raw)||!ID.test(supplierId)||currency!=="EUR"||raw.length>500)
   throw new Error("CARAVEL_EXTRAS_REFERENCE_INVALID");
 const catalog:CaravelExtra[]=[],unavailable:Array<{name:string;reason:string}>=[];
 const ids=new Set<string>(),codes=new Set<string>();
 for(const item of raw){
  const e=obj(item);
  if(!e)throw new Error("CARAVEL_EXTRA_RECORD_INVALID");
  if(e.supplier_id!==supplierId)continue;
  const name=typeof e.name==="string"&&e.name.trim().length>0&&e.name.length<=140?e.name.trim():"";
  const id=typeof e.extra_id==="string"?e.extra_id:"";
  const code=typeof e.code==="string"?e.code:"";
  if(!name||!ID.test(id)||!ID.test(code)||ids.has(id)||codes.has(code))
    throw new Error("CARAVEL_EXTRA_IDENTITY_INVALID");
  ids.add(id);codes.add(code);
  const unit=MONEY(e.unit_price,currency);
  const cap=e.price_cap==null?null:MONEY(e.price_cap,currency);
  const qty=obj(e.quantity),max=qty?.max;
  const quantity=e.requires_quantity===true?max:1;
  const min=qty?.min;
  const qtyNum=typeof quantity==="number"?quantity:NaN;
  const minNum=typeof min==="number"?min:NaN;
  const category=typeof e.category==="string"&&/^[a-z][a-z0-9_]{0,45}$/.test(e.category)?e.category:"other";
  const exclusive=typeof e.mutually_exclusive_group==="string"&&ID.test(e.mutually_exclusive_group)?e.mutually_exclusive_group:null;
  let reason="";
  if(category==="additional_driver")reason="ADDITIONAL_DRIVER_DATA_REQUIRED";
  else if(e.active===false)reason="NOT_AVAILABLE";
  else if(e.payable!=="at_pickup")reason="PAYMENT_METHOD_UNSUPPORTED";
  else if(e.pricing_type!=="per_day"&&e.pricing_type!=="per_rental")reason="PRICING_UNVERIFIED";
  else if(unit===null||((e.price_cap!==null&&e.price_cap!==undefined)&&cap===null))reason="PRICE_UNVERIFIED";
  else if(!Number.isInteger(qtyNum)||qtyNum<1||qtyNum>9 || (min!==undefined&&min!==null&&(!Number.isInteger(minNum)||minNum>1||minNum<0)))
    reason="QUANTITY_UNSUPPORTED";
  if(reason){unavailable.push({name,reason});continue;}
  catalog.push({extra_id:id,code,name_en:name,name_pl:PL[category]||name,category,
   pricing_type:e.pricing_type as CaravelExtra["pricing_type"],unit_minor:unit!,
   price_cap_minor:cap,currency,max_quantity:quantity as number,payable:"at_pickup",
   mutually_exclusive_group:exclusive});
 }
 return {catalog,unavailable};
}
export function caravelCheckExtraSelection(
 choices:unknown,catalog:CaravelExtra[],
 lines:Array<{code:string;quantity:number;totalMinor:number}>|null,
 rentalDays:number
):{ok:true;priced:CaravelPricedExtra[];totalMinor:number}|{ok:false;reason:string}{
 if(!Array.isArray(choices)||choices.length>12||!Number.isSafeInteger(rentalDays)||rentalDays<1||rentalDays>366)
  return {ok:false,reason:"CARAVEL_EXTRA_SELECTION_INVALID"};
 const byId=new Map(catalog.map(x=>[x.extra_id,x])),used=new Set<string>(),groups=new Set<string>(), priced:CaravelPricedExtra[]=[];
 for(const choice of choices){
  const c=obj(choice);if(!c||typeof c.extra_id!=="string"||!Number.isSafeInteger(c.quantity))
   return {ok:false,reason:"CARAVEL_EXTRA_SELECTION_INVALID"};
  const item=byId.get(c.extra_id);
  if(!item||used.has(c.extra_id)||Number(c.quantity)<1||Number(c.quantity)>item.max_quantity)
   return {ok:false,reason:"CARAVEL_EXTRA_SELECTION_INVALID"};
  if(item.mutually_exclusive_group && groups.has(item.mutually_exclusive_group))
   return {ok:false,reason:"CARAVEL_EXTRAS_MUTUALLY_EXCLUSIVE"};
  used.add(item.extra_id);
  if(item.mutually_exclusive_group)groups.add(item.mutually_exclusive_group);
 }
 if(lines===null) return choices.length === 0 ? {ok:true,priced:[],totalMinor:0} : {ok:false,reason:"CARAVEL_EXTRA_LINES_MISSING"};
 if(lines.length!==choices.length)return {ok:false,reason:"CARAVEL_EXTRAS_LINE_COUNT_MISMATCH"};
 let sum=0;
 for(const c of choices){
  const item=byId.get(c.extra_id)!;
  const matches=lines.filter(x=>x.code===item.code);
  if(matches.length!==1 || matches[0].quantity!==c.quantity ||
   !Number.isSafeInteger(matches[0].totalMinor)||matches[0].totalMinor<0)
   return {ok:false,reason:"CARAVEL_EXTRA_NOT_PRICED"};
  const amount=matches[0].totalMinor;
  const upper=item.price_cap_minor===null
   ?item.unit_minor*(item.pricing_type==="per_day"?rentalDays:1)*c.quantity
   :Math.min(item.price_cap_minor*c.quantity,
      item.unit_minor*(item.pricing_type==="per_day"?rentalDays:1)*c.quantity);
  if(!Number.isSafeInteger(upper)||amount>upper)
   return {ok:false,reason:"CARAVEL_EXTRA_PRICE_OUTSIDE_CATALOG"};
  sum+=amount;
  if(!Number.isSafeInteger(sum))return {ok:false,reason:"CARAVEL_EXTRAS_AMOUNT_OVERFLOW"};
  priced.push({extra_id:item.extra_id,code:item.code,quantity:c.quantity,
   name_en:item.name_en,name_pl:item.name_pl,total_minor:amount});
 }
 if(lines.some(x=>!catalog.some(c=>used.has(c.extra_id)&&x.code===c.code)))
  return {ok:false,reason:"CARAVEL_UNSELECTED_EXTRA_PRICED"};
 return {ok:true,priced,totalMinor:sum};
}
export function caravelSnapshotChoices(value:unknown):CaravelExtraChoice[]|null{
 if(!Array.isArray(value)||value.length>12)return null;
 const seen=new Set<string>();
 const result:CaravelExtraChoice[]=[];
 for(const v of value){
  const x=obj(v);
  if(!x||typeof x.extra_id!=="string"||!ID.test(x.extra_id)||
     !Number.isSafeInteger(x.quantity)||Number(x.quantity)<1||Number(x.quantity)>9||seen.has(x.extra_id))
   return null;
  seen.add(x.extra_id);result.push({extra_id:x.extra_id,quantity:x.quantity as number});
 }
 return result;
}
