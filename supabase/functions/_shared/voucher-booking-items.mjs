// Additional payment pages preserve the existing voucher's front page and QR layout.
export function wrapVoucherText(text, font, size, width) {
  const chars=Array.from(String(text).replace(/[\u0000-\u001f\u007f]/g,' ').trim());
  const lines=[];let line='';
  for(const char of chars){if(line && font.widthOfTextAtSize(line+char,size)>width){const split=line.lastIndexOf(' ');if(split>line.length/2){lines.push(line.slice(0,split));line=line.slice(split+1)+char;}else{lines.push(line);line=char;}}else line+=char;}
  if(line.trim())lines.push(line.trim());return lines.length?lines:[''];
}
export function validateVoucherPricing(value) {
  if(value==null)return null;
  if(value.version!==2 || !/^[A-Z]{3}$/.test(value.currency) || !Array.isArray(value.items) || value.items.length<1 || value.items.length>23)throw new Error('VOUCHER_INVALID_PRICING');
  const money=n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000;
  if(!['partner_cents','gross_cents','total_cents','loyalty_discount_cents','online_pln_cents'].every(k=>money(value[k])))throw new Error('VOUCHER_INVALID_PRICING');
  for(const item of value.items){if(!money(item.customer_cents)||!money(item.partner_cents)||typeof item.name_en!=='string'||typeof item.name_pl!=='string'||item.name_en.length>120||item.name_pl.length>120)throw new Error('VOUCHER_INVALID_PRICING');}
  if(value.items.reduce((s,x)=>s+x.customer_cents,0)!==value.gross_cents || value.items.reduce((s,x)=>s+x.partner_cents,0)!==value.partner_cents || value.gross_cents-value.loyalty_discount_cents!==value.total_cents)throw new Error('VOUCHER_INVALID_PRICING');
  return value;
}
export function appendVoucherPricing({pdfDoc,font,bold,rgb,booking,logoImage}) {
  const pricing=validateVoucherPricing(booking.pricing_items_snapshot);if(!pricing)return;
  const blue=rgb(.06,.22,.42),gray=rgb(.35,.4,.45),green=rgb(.1,.55,.15);
  let page,y,pageNumber=1;
  const pages=[];
  function next(){page=pdfDoc.addPage([600,800]);pages.push(page);pageNumber++;y=660;
    page.drawRectangle({x:40,y:695,width:520,height:65,color:rgb(.96,.97,.98)});
    if(logoImage)page.drawImage(logoImage,{x:55,y:711,width:80,height:32});
    page.drawText('PAYMENT DETAILS / SZCZEGÓŁY PŁATNOŚCI',{x:150,y:732,size:12,font:bold,color:blue});
    page.drawText(String(booking.reservation_code),{x:150,y:712,size:11,font,color:gray});
    page.drawText(`Ride24 | ${booking.reservation_code} | ${pageNumber}`,{x:50,y:35,size:9,font,color:gray});
  }
  function ensure(height){if(!page || y-height<80)next();}
  function line(pl,en,amount,{strong=false,location=''}={}){
    const lines=wrapVoucherText(en+' / '+pl,font,10,350);
    const locationLines=location?wrapVoucherText(location,font,9,350):[];
    const height=lines.length*14+locationLines.length*12+22;ensure(height);
    const amountText=amount;
    page.drawText(amountText,{x:550-(strong?bold:font).widthOfTextAtSize(amountText,11),y,size:11,font:strong?bold:font,color:strong?green:blue});
    for(const l of lines){page.drawText(l,{x:50,y,size:10,font:strong?bold:font,color:blue});y-=14;}
    for(const l of locationLines){page.drawText(l,{x:50,y,size:9,font,color:gray});y-=12;}
    y-=8;page.drawLine({start:{x:50,y},end:{x:550,y},thickness:.5,color:rgb(.87,.9,.93)});y-=14;
  }
  const money=(n,c=pricing.currency)=>(n/100).toFixed(2)+' '+c;
  next();
  for(const item of pricing.items){
    const count=item.kind==='extra'?` x ${item.quantity}`:'';
    const daily=item.kind==='extra' && item.billing==='day';
    const pl=count+(daily?` x ${item.days} ${item.days===1?'dzień':'dni'}`:'');
    const en=count+(daily?` x ${item.days} ${item.days===1?'day':'days'}`:'');
    line(item.name_pl+pl,item.name_en+en,money(item.customer_cents),{location:item.location_name||''});
  }
  ensure(210);
  if(pricing.loyalty_discount_cents)line('Rabat lojalnościowy','Loyalty discount','-'+money(pricing.loyalty_discount_cents));
  line('Łącznie','Total',money(pricing.total_cents),{strong:true});
  line('Zapłacono online Ride24','Paid online to Ride24',money(pricing.online_pln_cents,'PLN'));
  line('Do zapłaty partnerowi','Payable to the rental partner',money(pricing.partner_cents),{strong:true});
  ensure(40);
  for(const l of wrapVoucherText('Online payment is settled in PLN at the booking exchange rate. / Płatność online rozliczono w PLN według kursu zapisanego przy rezerwacji.',font,9,500)){page.drawText(l,{x:50,y,size:9,font,color:gray});y-=12;}
  return pages;
}
