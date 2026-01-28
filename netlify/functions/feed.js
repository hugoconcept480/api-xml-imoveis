const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

// --- CONFIGURAÇÕES ---
const DOMINIO_VITRINE = "vitrine.imob86.conceptsoft.com.br"; 
const WHATSAPP_PADRAO = "5586999999999"; // Preencha com o seu se quiser

// --- MAPAS ---
function mapListingType(operacao) {
    if (!operacao) return 'for_sale_by_agent'; 
    const op = String(operacao).toUpperCase();
    if (op.includes('ALUGUEL') || op.includes('LOCAÇÃO')) return 'for_rent_by_agent';
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

// --- GERADOR DE LINKS ---
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
    let clientHash = params.hash;

    if (!clientHash && event.path) {
        const parts = event.path.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart !== 'feed') {
            clientHash = lastPart;
        }
    }

    const clientDomain = params.domain || null; 
    const urlFormat = params.url_format || null; 
    const clientPhone = params.phone || null; 

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

                // Dados Básicos
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
                const listingType = mapListingType(getVal(imovel.operacao)); 
                const propertyType = mapPropertyType(tipoNome);

                const link = buildLink(clientDomain, id, urlFormat, clientPhone);

                // Imagens (Tratamento reforçado para lista vazia)
                let additionalImages = [];
                let imageLink = "";
                
                // Verifica se existe a tag imagens e se ela não é vazia
                if (imovel.imagens && imovel.imagens.imagem) {
                    const imgs = Array.isArray(imovel.imagens.imagem) ? imovel.imagens.imagem : [imovel.imagens.imagem];
                    if (imgs.length > 0) {
                        imageLink = getVal(imgs[0].path);
                        additionalImages = imgs.slice(1, 11).map(img => getVal(img.path)).filter(p => p !== "");
                    }
                }

                // Quartos/Banheiros
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
                    "g:image_link": imageLink, // Se estiver vazio, o Facebook pode alertar, mas não quebra o XML
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
                console.log(`Erro item ${imovel.idNaImobiliaria}:`, err.message);
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
                // MUDANÇA CRUCIAL: Desliga o cache para testes
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            body: finalXml
        };

    } catch (error) {
        return { statusCode: 500, body: error.toString() };
    }
};
