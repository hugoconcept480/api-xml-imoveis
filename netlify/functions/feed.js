const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

// --- CONFIGURAÇÕES ---
const DOMINIO_VITRINE = "vitrine.imob86.conceptsoft.com.br"; 
const WHATSAPP_PADRAO = "5586999999999"; 

// --- PADRONIZADORES (NORMALIZERS) ---

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

// --- TRADUTORES PARA O FACEBOOK ---

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
    if (!valor) return '0.00 BRL';
    const clean = String(valor).replace(/[^\d.]/g, '');
    const num = parseFloat(clean);
    if (isNaN(num)) return '0.00 BRL';
    return `${num.toFixed(2)} BRL`;
}

// --- CONSTRUTOR DE URL ---
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

// --- FUNÇÃO PRINCIPAL ---

exports.handler = async function(event, context) {
    const params = event.queryStringParameters || {};
    
    let identifier = params.hash; 
    if (!identifier && event.path) {
        const parts = event.path.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart !== 'feed') {
            identifier = lastPart;
        }
    }

    if (!identifier) return { statusCode: 400, body: "Identificador (Hash ou ID) obrigatório." };

    const source = params.source || 'native'; 
    const clientDomain = params.domain || null; 
    const urlFormat = params.url_format || null; 
    const clientPhone = params.phone || null; 

    // SELEÇÃO DA URL DE ORIGEM
    let SOURCE_URL = "";
    // AGORA ACEITA 'group' OU 'olx'
    if (source === 'olx' || source === 'group') {
        SOURCE_URL = `https://imob86.concept.inf.br/olx/${identifier}/grupo_olx.xml`;
    } else {
        SOURCE_URL = `https://xml.imob86.conceptsoft.com.br/Imob86XML/listar/${identifier}`;
    }

    try {
        const response = await fetch(SOURCE_URL, { timeout: 20000 });
        if (!response.ok) {
            return { statusCode: 502, body: `Erro ao buscar XML (${source}): ${response.status}` };
        }
        const xmlText = await response.text();

        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(xmlText);

        let normalizedItems = [];

        // PROCESSAMENTO DE ACORDO COM A FONTE
        if (source === 'olx' || source === 'group') {
            if (jsonObj.ListingDataFeed && jsonObj.ListingDataFeed.Listings && jsonObj.ListingDataFeed.Listings.Listing) {
                const rawList = jsonObj.ListingDataFeed.Listings.Listing;
                const list = Array.isArray(rawList) ? rawList : [rawList];
                normalizedItems = list.map(item => normalizeOLX(item));
            }
        } else {
            if (jsonObj.imoveis && jsonObj.imoveis.imovel) {
                const rawList = jsonObj.imoveis.imovel;
                const list = Array.isArray(rawList) ? rawList : [rawList];
                normalizedItems = list.map(item => normalizeNative(item));
            }
        }

        const rssItems = [];

        for (const item of normalizedItems) {
            try {
                if (!item.id) continue;

                let titulo = item.title;
                if (!titulo || typeof titulo !== 'string' || titulo.trim() === "") {
                    titulo = `${item.type} em ${item.bairro}`; 
                    if (item.cidade) titulo += ` - ${item.cidade}`;
                }

                const description = item.description ? String(item.description).substring(0, 4900) : titulo;
                const finalLink = buildLink(clientDomain, item.id, urlFormat, clientPhone);

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

                rssItems.push(itemObj);

            } catch (err) { continue; }
        }

        const builder = new XMLBuilder({ format: true, ignoreAttributes: false, cdataPropName: "title" });
        const finalObj = {
            rss: {
                "@_xmlns:g": "http://base.google.com/ns/1.0",
                "@_version": "2.0",
                channel: {
                    title: "Feed Imoveis",
                    description: `Feed gerado via ${source === 'group' || source === 'olx' ? 'Imob86 Grupo' : 'Imob86 Nativo'}`,
                    link: clientDomain ? `https://${clientDomain}` : `https://wa.me/`,
                    item: rssItems
                }
            }
        };

        const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n` + builder.build(finalObj);

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
