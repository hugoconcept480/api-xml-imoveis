const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

exports.handler = async function(event, context) {
    // 1. Pegar parâmetros
    const params = event.queryStringParameters || {};
    let clientHash = params.hash;

    // --- CORREÇÃO DO LINK BONITO ---
    // Se o hash não veio pelo parametro, tentamos pegar direto da URL
    // A URL vem como "/feed/SEU_HASH_AQUI"
    if (!clientHash && event.path) {
        const parts = event.path.split('/');
        const lastPart = parts[parts.length - 1]; // Pega o último pedaço da URL
        if (lastPart && lastPart !== 'feed') {
            clientHash = lastPart;
        }
    }
    // -------------------------------

    const clientDomain = params.domain || 'seusite.com.br';

    if (!clientHash) {
        return { statusCode: 400, body: "Hash obrigatorio. (Verifique se a URL está correta)" };
    }

    const SOURCE_URL = `https://xml.imob86.conceptsoft.com.br/Imob86XML/listar/${clientHash}`;

    try {
        // 2. Baixar o XML original
        const response = await fetch(SOURCE_URL, { timeout: 8000 });
        if (!response.ok) {
            return { statusCode: 502, body: `Erro na Origem: ${response.status}` };
        }
        const xmlText = await response.text();

        // 3. Converter XML para JSON
        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(xmlText);

        let imoveis = [];
        if (jsonObj.imoveis && jsonObj.imoveis.imovel) {
            imoveis = Array.isArray(jsonObj.imoveis.imovel) ? jsonObj.imoveis.imovel : [jsonObj.imoveis.imovel];
        }

        // 4. Montar o novo XML (RSS)
        const rssItems = [];
        
        for (const imovel of imoveis) {
            try {
                const getVal = (path) => path || "";

                const id = getVal(imovel.idNaImobiliaria);
                if (!id) continue;

                let titulo = getVal(imovel.tituloSite);
                if (!titulo && imovel.tipoImovel && imovel.bairro) {
                    titulo = `${imovel.tipoImovel.nome} em ${imovel.bairro.nome}`;
                }

                const price = `${getVal(imovel.valor) || '0'} BRL`;
                const link = `https://${clientDomain}/imovel/${id}`;
                // Proteção contra descrição nula
                const rawDesc = getVal(imovel.descricao);
                const description = typeof rawDesc === 'string' ? rawDesc.substring(0, 4900) : "";
                
                const endereco = getVal(imovel.endereco);
                const cidade = imovel.cidade ? getVal(imovel.cidade.nome) : "";
                const cep = getVal(imovel.cep);
                
                let additionalImages = [];
                let imageLink = "";
                
                if (imovel.imagens && imovel.imagens.imagem) {
                    const imgs = Array.isArray(imovel.imagens.imagem) ? imovel.imagens.imagem : [imovel.imagens.imagem];
                    if (imgs.length > 0) {
                        imageLink = imgs[0].path; 
                        additionalImages = imgs.slice(1, 11).map(img => img.path);
                    }
                }

                const quartos = getVal(imovel.quartos) || "0";
                const banheiros = getVal(imovel.banheiros) || "0";

                rssItems.push({
                    "g:home_listing_id": id,
                    "title": titulo,
                    "g:description": description,
                    "g:price": price,
                    "g:availability": "for_sale",
                    "link": link,
                    "g:image_link": imageLink,
                    "g:additional_image_link": additionalImages,
                    "g:address": {
                        "@_format": "struct",
                        "g:addr1": endereco,
                        "g:city": cidade,
                        "g:region": "PI",
                        "g:postal_code": cep,
                        "g:country": "BR"
                    },
                    "g:num_beds": quartos,
                    "g:num_baths": banheiros,
                    "g:property_type": "apartment",
                    "g:listing_type": "for_sale_by_agent"
                });

            } catch (err) {
                console.log("Item ignorado", err);
                continue;
            }
        }

        // 5. Construir XML Final
        const builder = new XMLBuilder({ format: true, ignoreAttributes: false });
        const finalObj = {
            rss: {
                "@_xmlns:g": "http://base.google.com/ns/1.0",
                "@_version": "2.0",
                channel: {
                    title: "Feed Imoveis",
                    description: "Catalogo Meta Ads",
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
