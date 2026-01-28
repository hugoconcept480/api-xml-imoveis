const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

// --- CONFIGURAÇÃO DE SEGURANÇA (WHATSAPP) ---
// Se o cliente não tiver site, mandamos para o WhatsApp.
// Coloque aqui um número padrão da sua empresa ou deixe vazio para o cliente preencher.
// Formato: 55 + DDD + Numero (sem traços)
const WHATSAPP_PADRAO = "5586999999999"; 

// --- FUNÇÕES DE MAPEAMENTO ---

function mapListingType(operacao) {
    if (!operacao) return 'for_sale_by_agent'; 
    const op = String(operacao).toUpperCase();
    if (op.includes('ALUGUEL') || op.includes('LOCAÇÃO')) {
        return 'for_rent_by_agent';
    }
    return 'for_sale_by_agent';
}

function mapPropertyType(tipo) {
    if (!tipo) return 'other';
    const t = String(tipo).toUpperCase();
    if (t.includes('APARTAMENTO') || t.includes('FLAT') || t.includes('KITNET')) return 'apartment';
    if (t.includes('CASA') || t.includes('SOBRADO')) return 'house';
    if (t.includes('LOTE') || t.includes('TERRENO')) return 'land';
    return 'other'; 
}

function formatPrice(valor) {
    if (!valor) return '0.00 BRL';
    return `${parseFloat(valor).toFixed(2)} BRL`;
}

// --- FUNÇÃO DE CONSTRUÇÃO DE LINK (A Mágica do {id}) ---
function buildLink(domain, id, format, phone) {
    // CENÁRIO 1: Sem domínio -> Manda pro WhatsApp
    if (!domain || domain === 'null') {
        const zapNumber = phone || WHATSAPP_PADRAO;
        const text = encodeURIComponent(`Olá, tenho interesse no imóvel código ${id}`);
        return `https://wa.me/${zapNumber}?text=${text}`;
    }

    const cleanDomain = domain.replace(/\/$/, ""); 

    // CENÁRIO 2: Formato Customizado com Coringa {id}
    // Ex: format="/imoveis?codigo={id}" vira "site.com/imoveis?codigo=123"
    if (format && format.includes('{id}')) {
        const path = format.replace('{id}', id);
        // Garante que não duplique a barra inicial se o usuario esquecer
        const cleanPath = path.startsWith('/') ? path : '/' + path;
        return `https://${cleanDomain}${cleanPath}`;
    }

    // CENÁRIO 3: Padrão Imob86 (/imovel/123)
    return `https://${cleanDomain}/imovel/${id}`;
}

// --- FUNÇÃO PRINCIPAL ---

exports.handler = async function(event, context) {
    const params = event.queryStringParameters || {};
    let clientHash = params.hash;

    // Pega hash da URL
    if (!clientHash && event.path) {
        const parts = event.path.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart !== 'feed') {
            clientHash = lastPart;
        }
    }

    // PARÂMETROS DA URL
    const clientDomain = params.domain || null; // Se não passar, é null
    const urlFormat = params.url_format || null; // Formato curinga
    const clientPhone = params.phone || null; // Para o WhatsApp se não tiver site

    if (!clientHash) {
        return { statusCode: 400, body: "Hash obrigatorio." };
    }

    const SOURCE_URL = `https://xml.imob86.conceptsoft.com.br/Imob86XML/listar/${clientHash}`;

    try {
        const response = await fetch(SOURCE_URL, { timeout: 15000 });
        if (!response.ok) {
            return { statusCode: 502, body: `Erro na Origem: ${response.status}` };
        }
        const xmlText = await response.text();

        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(xmlText);

        let imoveis = [];
        if (jsonObj.imoveis && jsonObj.imoveis.imovel) {
            imoveis = Array.isArray(jsonObj.imoveis.imovel) ? jsonObj.imoveis.imovel : [jsonObj.imoveis.imovel];
        }

        const rssItems = [];
        
        for (const imovel of imoveis) {
            try {
                const getVal = (val) => {
                    if (val === undefined || val === null) return "";
                    if (typeof val === 'object' && Object.keys(val).length === 0) return ""; 
                    return val;
                };

                const id = getVal(imovel.idNaImobiliaria);
                if (!id) continue; 

                const bairro = imovel.bairro ? getVal(imovel.bairro.nome) : "";
                const cidade = imovel.cidade ? getVal(imovel.cidade.nome) : "";
                const tipoNome = imovel.tipoImovel ? getVal(imovel.tipoImovel.nome) : "Imóvel";
                
                let titulo = getVal(imovel.tituloSite);
                if (!titulo) {
                    titulo = `${tipoNome} em ${bairro}`; 
                    if (cidade) titulo += ` - ${cidade}`;
                }

                const rawDesc = getVal(imovel.descricao);
                const description = String(rawDesc).substring(0, 4900) || titulo;
                const price = formatPrice(imovel.valor);
                const operacao = getVal(imovel.operacao); 
                const listingType = mapListingType(operacao); 
                const propertyType = mapPropertyType(tipoNome);

                // --- GERA O LINK (Site ou WhatsApp) ---
                const link = buildLink(clientDomain, id, urlFormat, clientPhone);

                let additionalImages = [];
                let imageLink = "";
                
                if (imovel.imagens && imovel.imagens.imagem) {
                    const imgs = Array.isArray(imovel.imagens.imagem) ? imovel.imagens.imagem : [imovel.imagens.imagem];
                    if (imgs.length > 0) {
                        imageLink = getVal(imgs[0].path);
                        additionalImages = imgs.slice(1, 11).map(img => getVal(img.path)).filter(p => p !== "");
                    }
                }

                const quartos = String(getVal(imovel.quartos) || "0");
                const banheiros = String(getVal(imovel.banheiros) || "0");
                const area = String(getVal(imovel.area) || "0");

                const itemObj = {
                    "g:home_listing_id": id,
                    "title": titulo,
                    "g:description": description,
                    "g:price": price,
                    "g:listing_type": listingType, 
                    "g:property_type": propertyType,
                    "link": link,
                    "g:image_link": imageLink,
                    "g:address": {
                        "@_format": "struct",
                        "g:addr1": getVal(imovel.endereco),
                        "g:city": cidade,
                        "g:region": getVal(imovel.estado?.nome) || "PI",
                        "g:postal_code": getVal(imovel.cep),
                        "g:country": "BR"
                    },
                    "g:neighborhood": bairro,
                    "g:num_beds": quartos,
                    "g:num_baths": banheiros,
                };

                if (additionalImages.length > 0) itemObj["g:additional_image_link"] = additionalImages;
                if (area !== "0") itemObj["g:area"] = { "#text": area, "@_unit": "sq m" };

                rssItems.push(itemObj);

            } catch (err) {
                continue;
            }
        }

        const builder = new XMLBuilder({ format: true, ignoreAttributes: false, cdataPropName: "title" });
        const finalObj = {
            rss: {
                "@_xmlns:g": "http://base.google.com/ns/1.0",
                "@_version": "2.0",
                channel: {
                    title: "Feed Imoveis",
                    description: "Integração Imob86 Meta Ads",
                    link: clientDomain ? `https://${clientDomain}` : `https://wa.me/${clientPhone || WHATSAPP_PADRAO}`,
                    item: rssItems
                }
            }
        };

        const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n` + builder.build(finalObj);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'public, max-age=3600'
            },
            body: finalXml
        };

    } catch (error) {
        return { statusCode: 500, body: error.toString() };
    }
};
