const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

// --- CONFIGURAÇÕES ---
const DOMINIO_VITRINE = "vitrine.imob86.conceptsoft.com.br"; 
const WHATSAPP_PADRAO = "5586999999999"; 

// ==========================================
// 1. CAMADA DE NORMALIZAÇÃO (ENTRADA)
// ==========================================

function normalizeNative(imovel) {
    const getVal = (val) => {
        if (val === undefined || val === null) return "";
        if (typeof val === 'object' && Object.keys(val).length === 0) return ""; 
        return val;
    };

    let imgs = [];
    if (imovel.imagens && imovel.imagens.imagem) {
        const raw = Array.isArray(imovel.imagens.imagem) ? imovel.imagens.imagem : [imovel.imagens.imagem];
        imgs = raw.map(img => getVal(img.path)).filter(p => p !== "");
    }

    return {
        id: getVal(imovel.idNaImobiliaria),
        title: getVal(imovel.tituloSite),
        description: getVal(imovel.descricao),
        price: getVal(imovel.valor),
        operation: getVal(imovel.operacao), 
        type: imovel.tipoImovel ? getVal(imovel.tipoImovel.nome) : "", 
        bairro: imovel.bairro ? getVal(imovel.bairro.nome) : "",
        cidade: imovel.cidade ? getVal(imovel.cidade.nome) : "",
        estado: imovel.estado ? getVal(imovel.estado.nome) : "PI",
        cep: getVal(imovel.cep),
        endereco: getVal(imovel.endereco),
        quartos: String(getVal(imovel.quartos) || "0"),
        banheiros: String(getVal(imovel.banheiros) || "0"),
        area: String(getVal(imovel.area) || "0"),
        images: imgs
    };
}

function normalizeOLX(listing) {
    const getVal = (val) => (val === undefined || val === null) ? "" : val;

    const details = listing.Details || {};
    let price = "0";
    if (details.ListPrice && details.ListPrice['#text']) price = details.ListPrice['#text'];
    else if (details.RentalPrice && details.RentalPrice['#text']) price = details.RentalPrice['#text'];
    else if (typeof details.ListPrice === 'number') price = details.ListPrice;
    else if (typeof details.RentalPrice === 'number') price = details.RentalPrice;

    let imgs = [];
    if (listing.Media && listing.Media.Item) {
        const raw = Array.isArray(listing.Media.Item) ? listing.Media.Item : [listing.Media.Item];
        imgs = raw.map(item => item['#text'] || item).filter(p => typeof p === 'string' && p.startsWith('http'));
    }

    const loc = listing.Location || {};
    
    return {
        id: getVal(listing.ListingID),
        title: getVal(listing.Title),
        description: getVal(details.Description),
        price: String(price),
        operation: getVal(listing.TransactionType), 
        type: getVal(details.PropertyType), 
        bairro: getVal(loc.Neighborhood),
        cidade: getVal(loc.City),
        estado: loc.State && loc.State['#text'] ? loc.State['#text'] : "PI",
        cep: getVal(loc.PostalCode),
        endereco: getVal(loc.Address),
        quartos: String(getVal(details.Bedrooms) || "0"),
        banheiros: String(getVal(details.Bathrooms) || "0"),
        area: String(getVal(details.LivingArea && details.LivingArea['#text'] ? details.LivingArea['#text'] : (details.LivingArea || "0"))),
        images: imgs
    };
}

// ==========================================
// 2. HELPERS (FORMATAÇÃO)
// ==========================================

function mapListingType(rawOperation) {
    if (!rawOperation) return 'for_sale_by_agent'; 
    const op = String(rawOperation).toUpperCase();
    if (op.includes('ALUGUEL') || op.includes('LOCAÇÃO') || op.includes('RENT')) return 'for_rent_by_agent';
    return 'for_sale_by_agent';
}

function mapPropertyType(rawType) {
    if (!rawType) return 'other';
    const t = String(rawType).toUpperCase();
    if (t.includes('APARTAMENTO') || t.includes('FLAT') || t.includes('KITNET') || t.includes('/ APARTMENT')) return 'apartment';
    if (t.includes('CASA') || t.includes('SOBRADO') || t.includes('/ HOME')) return 'house';
    if (t.includes('LOTE') || t.includes('TERRENO') || t.includes('LAND')) return 'land';
    return 'other'; 
}

function formatPrice(valor) {
    if (!valor) return '0.00 USD'; // Default se falhar
    const clean = String(valor).replace(/[^\d.]/g, '');
    const num = parseFloat(clean);
    if (isNaN(num)) return '0.00 USD';
    // Nota: O formato Meta Native prefere virgula para decimais em alguns locais, 
    // mas o padrão internacional aceita ponto. Vamos manter BRL.
    return `${num.toFixed(2)} BRL`;
}

function buildLink(domain, id, format, phone) {
    if (!domain || domain === 'null') {
        const zapNumber = phone || WHATSAPP_PADRAO;
        const text = encodeURIComponent(`Olá, tenho interesse no imóvel código ${id}`);
        return `https://wa.me/${zapNumber}?text=${text}`;
    }
    const cleanDomain = domain.replace(/\/$/, ""); 
    if (format && format.includes('{id}')) {
        const path = format.replace('{id}', id);
        const cleanPath = path.startsWith('/') ? path : '/' + path;
        return `https://${cleanDomain}${cleanPath}`;
    }
    return `https://${cleanDomain}/imovel/${id}`;
}

// ==========================================
// 3. CAMADA DE SAÍDA (BUILDERS)
// ==========================================

// --- OPÇÃO A: RSS 2.0 (Google Merchant) ---
function generateRSS(items, clientDomain, params) {
    const rssItems = items.map(item => {
        try {
            if (!item.id) return null;
            let titulo = item.title || `${item.type} em ${item.bairro}`;
            const description = item.description ? String(item.description).substring(0, 4900) : titulo;
            const finalLink = buildLink(clientDomain, item.id, params.url_format, params.phone);

            const itemObj = {
                "g:home_listing_id": item.id,
                "title": titulo,
                "g:description": description,
                "g:price": formatPrice(item.price),
                "g:listing_type": mapListingType(item.operation), 
                "g:property_type": mapPropertyType(item.type),
                "link": finalLink,
                "g:image_link": item.images[0] || "",
                "g:address": {
                    "@_format": "struct",
                    "g:addr1": item.endereco,
                    "g:city": item.cidade,
                    "g:region": item.estado,
                    "g:postal_code": item.cep,
                    "g:country": "BR"
                },
                "g:neighborhood": item.bairro,
                "g:num_beds": item.quartos,
                "g:num_baths": item.banheiros,
            };

            if (item.images.length > 1) itemObj["g:additional_image_link"] = item.images.slice(1, 11);
            if (item.area && item.area !== "0") itemObj["g:area"] = { "#text": item.area, "@_unit": "sq m" };

            return itemObj;
        } catch (e) { return null; }
    }).filter(i => i !== null);

    const builder = new XMLBuilder({ format: true, ignoreAttributes: false, cdataPropName: "title" });
    const finalObj = {
        rss: {
            "@_xmlns:g": "http://base.google.com/ns/1.0",
            "@_version": "2.0",
            channel: {
                title: "Feed Imoveis",
                description: "Feed RSS 2.0",
                link: clientDomain ? `https://${clientDomain}` : `https://wa.me/`,
                item: rssItems
            }
        }
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n` + builder.build(finalObj);
}

// --- OPÇÃO B: META NATIVE (O XML do Cliente) ---
function generateMetaNative(items, clientDomain, params) {
    const listingItems = items.map(item => {
        try {
            if (!item.id) return null;
            let titulo = item.title || `${item.type} em ${item.bairro}`;
            const finalLink = buildLink(clientDomain, item.id, params.url_format, params.phone);

            // Mapeia disponibilidade
            const avail = mapListingType(item.operation) === 'for_rent_by_agent' ? 'for_rent' : 'for_sale';

            const itemObj = {
                home_listing_id: item.id,
                name: titulo,
                availability: avail, // Tag específica desse formato
                description: item.description ? String(item.description).substring(0, 4900) : titulo,
                price: formatPrice(item.price),
                url: finalLink, // Tag URL em vez de Link
                image: {
                    url: item.images[0] || ""
                },
                address: {
                    "@_format": "simple",
                    component: [
                        { "@_name": "addr1", "#text": item.endereco },
                        { "@_name": "city", "#text": item.cidade },
                        { "@_name": "region", "#text": item.estado },
                        { "@_name": "postal_code", "#text": item.cep },
                        { "@_name": "country", "#text": "Brazil" }
                    ]
                },
                latitude: "0", // Opcional mas bom ter
                longitude: "0",
                neighborhood: item.bairro,
                num_beds: item.quartos,
                num_baths: item.banheiros
            };
            
            // Imagens adicionais neste formato costumam ser repetidas ou tags especificas
            // Vamos manter simples conforme o exemplo
            return itemObj;
        } catch (e) { return null; }
    }).filter(i => i !== null);

    const builder = new XMLBuilder({ format: true, ignoreAttributes: false });
    const finalObj = {
        listings: {
            title: "Feed Imoveis Meta Native",
            listing: listingItems
        }
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n` + builder.build(finalObj);
}

// ==========================================
// 4. MAIN HANDLER
// ==========================================

exports.handler = async function(event, context) {
    const params = event.queryStringParameters || {};
    
    // Identificador
    let identifier = params.hash; 
    if (!identifier && event.path) {
        const parts = event.path.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart !== 'feed') identifier = lastPart;
    }
    if (!identifier) return { statusCode: 400, body: "Identificador obrigatório." };

    // Configurações
    const source = params.source || 'native'; 
    const outputFormat = params.output_format || 'rss'; // 'rss' ou 'meta_native'
    
    // Busca Dados
    let SOURCE_URL = "";
    if (source === 'olx' || source === 'group') {
        SOURCE_URL = `https://imob86.concept.inf.br/olx/${identifier}/grupo_olx.xml`;
    } else {
        SOURCE_URL = `https://xml.imob86.conceptsoft.com.br/Imob86XML/listar/${identifier}`;
    }

    try {
        const response = await fetch(SOURCE_URL, { timeout: 20000 });
        if (!response.ok) return { statusCode: 502, body: `Erro Origem: ${response.status}` };
        const xmlText = await response.text();

        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(xmlText);

        // Normalização (Transforma em Objeto Padrão)
        let normalizedItems = [];
        if (source === 'olx' || source === 'group') {
            if (jsonObj.ListingDataFeed?.Listings?.Listing) {
                const list = [].concat(jsonObj.ListingDataFeed.Listings.Listing);
                normalizedItems = list.map(item => normalizeOLX(item));
            }
        } else {
            if (jsonObj.imoveis?.imovel) {
                const list = [].concat(jsonObj.imoveis.imovel);
                normalizedItems = list.map(item => normalizeNative(item));
            }
        }

        // Geração da Saída (Escolhe o Builder)
        let finalXml = "";
        const buildParams = { 
            url_format: params.url_format, 
            phone: params.phone 
        };
        const clientDomain = params.domain || null; 

        if (outputFormat === 'meta_native') {
            finalXml = generateMetaNative(normalizedItems, clientDomain, buildParams);
        } else {
            finalXml = generateRSS(normalizedItems, clientDomain, buildParams);
        }

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            body: finalXml
        };

    } catch (error) {
        return { statusCode: 500, body: `Erro Interno: ${error.toString()}` };
    }
};
